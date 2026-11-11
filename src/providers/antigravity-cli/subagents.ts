import type { SubagentFacts } from '../../types.ts';
import { ID, parseSummary, type Reader, summariesOf } from './data.ts';
import { message, num, str, timestamp } from './protobuf.ts';
import { storagePath, trajectoryMetadata } from './storage.ts';
import { readStream, streamState } from './stream.ts';

export async function subagents(
	ctx: Reader,
	home: string,
	sessionId: string,
): Promise<SubagentFacts[]> {
	if (!ID.test(sessionId) || !ctx.sqlite || !(await ctx.fs.stat(summariesOf(home)))?.isFile)
		return [];
	const rows = await ctx.sqlite.query(
		summariesOf(home),
		'SELECT conversation_id, parent_conversation_id, title, status, killed, not_fully_idle, last_modified_time FROM conversation_summaries',
	);
	const byId = new Map(
		rows.flatMap((row) =>
			typeof row.conversation_id === 'string' && ID.test(row.conversation_id)
				? [[row.conversation_id, row] as const]
				: [],
		),
	);
	const result: SubagentFacts[] = [];
	for (const [id, row] of byId) {
		if (id === sessionId) continue;
		const parent = row.parent_conversation_id;
		if (typeof parent !== 'string' || !ID.test(parent)) continue;
		let ancestor = parent;
		const visited = new Set([id]);
		while (ancestor !== sessionId && !visited.has(ancestor)) {
			visited.add(ancestor);
			const next = byId.get(ancestor)?.parent_conversation_id;
			if (typeof next !== 'string' || !ID.test(next)) break;
			ancestor = next;
		}
		if (ancestor !== sessionId) continue;
		const path = await storagePath(ctx, home, id);
		if (!path) continue;
		const meta = await trajectoryMetadata(ctx, path);
		let details: Pick<SubagentFacts, 'type' | 'title' | 'background' | 'startedAt'>;
		try {
			// A conflicting persisted parent/root is not a safe association.
			if ((str(meta, 5) && str(meta, 5) !== parent) || (str(meta, 6) && str(meta, 6) !== sessionId))
				continue;
			const spec = message(meta, 8);
			details = {
				type: str(spec, 1) ?? 'subagent',
				title: str(spec, 2),
				background: num(spec, 9) === 1,
				startedAt: timestamp(meta, 2),
			};
		} catch {
			continue;
		}
		const stream = await readStream(ctx, path, streamState());
		const end = stream.events
			.slice()
			.reverse()
			.find((e) => e.kind === 'turn-end');
		const running = row.status !== 'CASCADE_RUN_STATUS_IDLE' || row.not_fully_idle === 1;
		const status =
			row.killed === 1
				? 'cancelled'
				: running || !end || end.kind !== 'turn-end'
					? 'running'
					: end.outcome === 'failed'
						? 'failed'
						: end.outcome === 'interrupted'
							? 'cancelled'
							: 'completed';
		const summary = parseSummary(row, true);
		result.push({
			id,
			sessionId,
			parentId: parent === sessionId ? undefined : parent,
			harness: 'AntiGravity',
			...details,
			title: summary?.snapshot.title ?? details.title,
			status,
			endedAt: status === 'running' ? undefined : (end?.at ?? summary?.snapshot.updatedAt),
		});
	}
	return result;
}
