import type { SqliteRow } from '../../helpers/types.ts';

// omp upserts on the prompt text: typing a prompt used before moves its row's
// `created_at` and `session_id` but keeps its id, so new ids alone would miss it.
export const HISTORY_ROWS =
	'SELECT id, created_at, session_id, prompt FROM history WHERE id > ? OR created_at >= ? ORDER BY created_at, id';
export const NEWEST_ROWS =
	'SELECT id, created_at, session_id, prompt FROM history WHERE created_at = (SELECT max(created_at) FROM history)';
export const MAX_ID = 'SELECT max(id) AS id FROM history';

/** Where we are in `history.db`: the highest id, the newest second, and the rows seen at it. */
export type HistoryCursor = { id: number; at: number; seen: Set<string> };

const keyOf = (row: SqliteRow): string =>
	JSON.stringify([row.id, row.created_at, row.session_id, row.prompt]);

/** Starts at the newest row: what is already there begins nothing. */
export function seedCursor(maxId: number, newest: SqliteRow[]): HistoryCursor {
	const cursor: HistoryCursor = { id: maxId, at: 0, seen: new Set() };
	for (const row of newest) {
		cursor.at = Number(row.created_at) || 0;
		cursor.seen.add(keyOf(row));
	}
	return cursor;
}

/** The rows of a `HISTORY_ROWS` query not seen before, advancing the cursor past them. */
export function takeFresh(cursor: HistoryCursor, rows: SqliteRow[]): SqliteRow[] {
	const fresh: SqliteRow[] = [];
	for (const row of rows) {
		const id = Number(row.id);
		const at = Number(row.created_at) || 0;
		const key = keyOf(row);
		if (!(id > cursor.id || at > cursor.at || (at === cursor.at && !cursor.seen.has(key)))) {
			continue;
		}
		fresh.push(row);
		if (Number.isFinite(id) && id > cursor.id) cursor.id = id;
		if (at > cursor.at) {
			cursor.at = at;
			cursor.seen.clear();
		}
		if (at === cursor.at) cursor.seen.add(key);
	}
	return fresh;
}
