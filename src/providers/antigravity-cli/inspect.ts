import { watchFile } from '../../helpers/watch-file.ts';
import type { InspectContext } from '../../provider.ts';
import type { SessionEvent } from '../../types.ts';
import { databaseOf, ID, steps, summaries, terminal } from './data.ts';
import { decodeStep } from './steps.ts';

export function freshEvents(events: SessionEvent[], tools: Set<string>): SessionEvent[] {
	return events.filter((event) => {
		if (event.kind !== 'tool') return true;
		if (tools.has(event.id)) return false;
		tools.add(event.id);
		return true;
	});
}

export async function* inspect(
	ctx: InspectContext,
	home: string,
	id: string,
): AsyncGenerator<SessionEvent> {
	if (!ID.test(id) || !ctx.sqlite || ctx.subagentId || ctx.signal?.aborted) return;
	if (!(await summaries(ctx, home, id)).length) return;
	const path = databaseOf(home, id);
	const inode = (await ctx.fs.stat(path))?.ino;
	let dirty = true,
		wake: (() => void) | undefined;
	const notify = (): void => {
		dirty = true;
		wake?.();
		wake = undefined;
	};
	const handles = ctx.follow
		? [path, `${path}-wal`].map((p) => watchFile(ctx.fs, p, notify, { heldOpen: true }))
		: [];
	ctx.signal?.addEventListener('abort', notify, { once: true });
	const tools = new Set<string>();
	let cursor = -1;
	try {
		do {
			if (ctx.signal?.aborted) return;
			dirty = false;
			const stat = await ctx.fs.stat(path);
			if (!stat || (inode != null && stat.ino != null && inode !== stat.ino)) return;
			for await (const row of steps(ctx, path, cursor)) {
				if (ctx.signal?.aborted) return;
				if (!terminal(row.status)) break;
				cursor = Number(row.idx);
				const decoded = decodeStep(row);
				if (decoded) yield* freshEvents(decoded.events, tools);
			}
			if (!ctx.follow) return;
			if (!dirty && !ctx.signal?.aborted)
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
		} while (!ctx.signal?.aborted);
	} finally {
		for (const handle of handles) handle.close();
		ctx.signal?.removeEventListener('abort', notify);
	}
}
