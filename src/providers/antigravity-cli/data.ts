import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Fs, Sqlite, SqliteRow } from '../../helpers/types.ts';
import type { SessionSnapshot, SessionStatus } from '../../types.ts';

export const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_PAYLOAD = 4 * 1024 * 1024;
export const homeOf = (home?: string): string =>
	home ?? join(homedir(), '.gemini', 'antigravity-cli');
export const databaseOf = (home: string, id: string): string =>
	join(home, 'conversations', `${id}.db`);
export const lockOf = (home: string, id: string): string => join(home, 'presence', `${id}.lock`);
export const summariesOf = (home: string): string => join(home, 'conversation_summaries.db');
export type Reader = { fs: Fs; sqlite?: Sqlite };
export type Summary = { snapshot: SessionSnapshot; status?: SessionStatus };

export function parseSummary(row: SqliteRow): Summary | undefined {
	if (typeof row.conversation_id !== 'string' || !ID.test(row.conversation_id)) return;
	if (row.parent_conversation_id != null && row.parent_conversation_id !== '') return;
	const snapshot: SessionSnapshot = {
		id: row.conversation_id,
		provider: 'antigravity-cli',
		harness: 'AntiGravity',
	};
	if (typeof row.title === 'string' && row.title.length <= 65536 && row.title.trim())
		snapshot.title = row.title;
	if (typeof row.last_modified_time === 'string') {
		// agy persists UTC datetime strings. Require an explicit zone, not the host's timezone.
		if (/(?:Z|[+-]\d\d:\d\d)$/.test(row.last_modified_time)) {
			const at = Date.parse(row.last_modified_time.replace(' ', 'T'));
			if (Number.isFinite(at) && at > 0) snapshot.updatedAt = at;
		}
	}
	try {
		if (typeof row.workspace_uris !== 'string' || row.workspace_uris.length > 1048576)
			return { snapshot, status: statusOf(row.status) };
		const uris: unknown = JSON.parse(row.workspace_uris);
		if (Array.isArray(uris)) {
			for (const uri of uris) {
				if (typeof uri !== 'string') continue;
				try {
					const url = new URL(uri);
					if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost')) continue;
					snapshot.cwd = fileURLToPath(url);
					break;
				} catch {
					/* Try the next workspace URI. */
				}
			}
		}
	} catch {
		/* Optional metadata is not a reason to lose a valid conversation. */
	}
	const status = statusOf(row.status);
	return { snapshot, status };
}

function statusOf(value: unknown): SessionStatus | undefined {
	switch (value) {
		case 'CASCADE_RUN_STATUS_IDLE':
			return 'idle';
		case 'CASCADE_RUN_STATUS_RUNNING':
		case 'CASCADE_RUN_STATUS_BUSY':
		case 'CASCADE_RUN_STATUS_CANCELING':
			return 'running';
		default:
			return;
	}
}

export async function summaries(ctx: Reader, home: string, id?: string): Promise<Summary[]> {
	if (!ctx.sqlite || (id != null && !ID.test(id))) return [];
	const path = summariesOf(home);
	if (!(await ctx.fs.stat(path))?.isFile) return [];
	const rows = await ctx.sqlite.query(
		path,
		`SELECT conversation_id, title, workspace_uris, status, parent_conversation_id, last_modified_time FROM conversation_summaries${id ? ' WHERE conversation_id = ?' : ''}`,
		id ? [id] : [],
	);
	const result: Summary[] = [];
	for (const row of rows) {
		const parsed = parseSummary(row);
		if (parsed && (await ctx.fs.stat(databaseOf(home, parsed.snapshot.id)))?.isFile)
			result.push(parsed);
	}
	return result;
}

export const terminal = (status: unknown): boolean => [3, 4, 5, 6, 7, 12].includes(Number(status));
export const STEP_COLUMNS = `idx, step_type, status, step_format, CASE WHEN length(step_payload) <= ${MAX_PAYLOAD} THEN step_payload ELSE NULL END AS step_payload`;

/** Pages keep a long conversation from becoming one unbounded SQLite result. */
export async function* steps(ctx: Reader, path: string, after = -1): AsyncGenerator<SqliteRow> {
	if (!ctx.sqlite || !(await ctx.fs.stat(path))?.isFile) return;
	for (;;) {
		const rows = await ctx.sqlite.query(
			path,
			`SELECT ${STEP_COLUMNS} FROM steps WHERE idx > ? ORDER BY idx LIMIT 256`,
			[after],
		);
		if (!rows.length) return;
		for (const row of rows) {
			if (
				typeof row.idx !== 'number' ||
				!Number.isSafeInteger(row.idx) ||
				row.idx < 0 ||
				row.idx <= after
			)
				return;
			after = row.idx;
			yield row;
		}
		if (rows.length < 256) return;
	}
}
