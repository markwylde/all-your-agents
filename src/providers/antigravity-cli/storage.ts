import { join } from 'node:path';
import type { SqliteRow } from '../../helpers/types.ts';
import type { SessionEvent } from '../../types.ts';
import { databaseOf, MAX_PAYLOAD, type Reader, steps } from './data.ts';
import { type Fields, fields, message, num, str } from './protobuf.ts';

const MAX_TRAJECTORY = 64 * 1024 * 1024;
export async function storagePath(
	ctx: Reader,
	home: string,
	id: string,
): Promise<string | undefined> {
	const db = databaseOf(home, id);
	if ((await ctx.fs.stat(db))?.isFile) return db;
	const pb = db.replace(/\.db$/, '.pb');
	if ((await ctx.fs.stat(pb))?.isFile) {
		// Older .pb files may be encrypted. Use agy's generated transcript, never keys/auth.
		for (const name of ['transcript_full.jsonl', 'transcript.jsonl']) {
			const log = join(home, 'brain', id, '.system_generated', 'logs', name);
			if ((await ctx.fs.stat(log))?.isFile) return log;
		}
	}
}
export async function* records(ctx: Reader, path: string, after = -1): AsyncGenerator<SqliteRow> {
	if (path.endsWith('.jsonl')) {
		const stat = await ctx.fs.stat(path);
		if (!stat || stat.size > MAX_TRAJECTORY) return;
		const text = new TextDecoder().decode(
			await ctx.fs.readFile(path, { maxBytes: MAX_TRAJECTORY }),
		);
		for (const line of text.split('\n')) {
			if (!line.trim() || line.length > MAX_PAYLOAD) continue;
			try {
				const row = JSON.parse(line);
				if (!Number.isSafeInteger(row.step_index) || row.step_index < 0 || row.step_index <= after)
					continue;
				yield {
					idx: row.step_index,
					step_type: row.type === 'USER_INPUT' ? 14 : row.type === 'PLANNER_RESPONSE' ? 15 : 0,
					status:
						row.status === 'DONE'
							? 3
							: row.status === 'ERROR'
								? 7
								: row.status === 'CANCELED'
									? 6
									: 2,
					legacy_json: line,
				};
			} catch {
				/* Incomplete trailing records are retried on the next notification. */
			}
		}
		return;
	}
	yield* steps(ctx, path, after);
}
async function blobs(ctx: Reader, path: string, table: string): Promise<Fields[]> {
	if (path.endsWith('.jsonl')) return [];
	if (!ctx.sqlite) return [];
	const result: Fields[] = [];
	let after = -1;
	for (;;) {
		const rows = await ctx.sqlite.query(
			path,
			`SELECT idx, CASE WHEN length(data) <= ${MAX_PAYLOAD} THEN data ELSE NULL END AS data FROM ${table} WHERE idx > ? ORDER BY idx LIMIT 128`,
			[after],
		);
		if (!rows.length) break;
		for (const row of rows) {
			if (typeof row.idx !== 'number' || row.idx <= after) return result;
			after = row.idx;
			try {
				if (row.data instanceof Uint8Array) result.push(fields(row.data));
			} catch {
				/* Skip only the malformed metadata row. */
			}
		}
		if (rows.length < 128) break;
	}
	return result;
}
export type Metadata = {
	model?: string;
	models: Map<string, string>;
	endings: { index: number; event: SessionEvent; error?: string }[];
};
export async function metadata(ctx: Reader, path: string): Promise<Metadata> {
	const result: Metadata = { models: new Map(), endings: [] };
	for (const generation of await blobs(ctx, path, 'gen_metadata')) {
		try {
			const model = str(message(generation, 1), 21);
			if (!model) continue;
			result.model = model;
			const execution = str(generation, 4);
			if (execution) result.models.set(execution, model);
			for (const value of generation.get(2) ?? []) {
				if (typeof value === 'number') result.models.set(`step:${value}`, model);
				else {
					let index = 0,
						shift = 0;
					for (const byte of value) {
						index += (byte & 127) * 2 ** shift;
						if (!(byte & 128)) {
							if (Number.isSafeInteger(index)) result.models.set(`step:${index}`, model);
							index = 0;
							shift = 0;
						} else {
							shift += 7;
							if (shift > 49) break;
						}
					}
				}
			}
		} catch {
			/* Malformed optional metadata does not hide conversation events. */
		}
	}
	for (const executor of await blobs(ctx, path, 'executor_metadata')) {
		try {
			const reason = num(executor, 1),
				index = num(executor, 3) ?? 0;
			const outcome =
				reason === 2
					? 'interrupted'
					: [1, 3, 6, 11].includes(reason ?? 0)
						? 'failed'
						: [4, 8, 9, 10].includes(reason ?? 0)
							? 'completed'
							: undefined;
			if (outcome)
				result.endings.push({
					index,
					error: str(executor, 12),
					event: { kind: 'turn-end', outcome, raw: { executor } },
				});
		} catch {
			/* Ignore a malformed optional executor record. */
		}
	}
	return result;
}
export async function trajectoryMetadata(ctx: Reader, path: string): Promise<Fields> {
	if (path.endsWith('.jsonl')) return new Map();
	if (!ctx.sqlite) return new Map();
	const row = (
		await ctx.sqlite.query(
			path,
			`SELECT CASE WHEN length(data) <= ${MAX_PAYLOAD} THEN data ELSE NULL END AS data FROM trajectory_metadata_blob WHERE id = 'main' LIMIT 1`,
		)
	)[0];
	try {
		return row?.data instanceof Uint8Array ? fields(row.data) : new Map();
	} catch {
		return new Map();
	}
}
