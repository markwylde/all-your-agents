import { watchFile } from '../../helpers/watch-file.ts';
import type { InspectContext } from '../../provider.ts';
import type { SessionEvent } from '../../types.ts';
import { ID, summaries } from './data.ts';
import { storagePath } from './storage.ts';
import { readStream, streamState } from './stream.ts';
import { subagents } from './subagents.ts';

export async function* inspect(
	ctx: InspectContext,
	home: string,
	id: string,
): AsyncGenerator<SessionEvent> {
	if (!ID.test(id) || !ctx.sqlite || ctx.signal?.aborted) return;
	if (!(await summaries(ctx, home, id)).length) return;
	if (
		ctx.subagentId &&
		!(await subagents(ctx, home, id)).some((child) => child.id === ctx.subagentId)
	)
		return;
	const path = await storagePath(ctx, home, ctx.subagentId ?? id);
	if (!path) return;
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
	let state = streamState();
	try {
		do {
			if (ctx.signal?.aborted) return;
			dirty = false;
			const stat = await ctx.fs.stat(path);
			if (!stat || (inode != null && stat.ino != null && inode !== stat.ino)) return;
			const result = await readStream(ctx, path, state);
			if (ctx.signal?.aborted) return;
			state = result.state;
			yield* result.events;
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
