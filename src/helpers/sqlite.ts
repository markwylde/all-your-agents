import type { Sqlite, SqliteRow, SqliteValue } from './types.ts';

type Statement = { all(...params: SqliteValue[]): unknown[] };
type Database = { prepare(sql: string): Statement; close(): void };
type SqliteModule = {
	DatabaseSync: new (path: string, options: { readOnly: boolean }) => Database;
};

/** Kept out of the import graph so a runtime without `node:sqlite` still loads the package. */
const BUILT_IN = 'node:sqlite';

/**
 * Imports `node:sqlite` without its `ExperimentalWarning`: every instance loads it, and a
 * consumer that never watches omp should not see a warning about it on stderr.
 */
async function importQuietly(): Promise<unknown> {
	const emit = process.emitWarning;
	process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
		const text = typeof warning === 'string' ? warning : warning?.message;
		if (text?.includes('SQLite')) return;
		(emit as (...args: unknown[]) => void).call(process, warning, ...rest);
	}) as typeof process.emitWarning;
	try {
		return await import(BUILT_IN);
	} finally {
		process.emitWarning = emit;
	}
}

/**
 * A reader over the runtime's built-in SQLite, or nothing when this Node has none. Every
 * call opens the database read-only and closes it again: we are never a standing holder
 * of someone else's database, and an idle reader cannot pin its WAL.
 */
export async function createLocalSqlite(
	load: () => Promise<unknown> = importQuietly,
): Promise<Sqlite | undefined> {
	let mod: SqliteModule;
	try {
		mod = (await load()) as SqliteModule;
		if (typeof mod?.DatabaseSync !== 'function') return undefined;
	} catch {
		return undefined;
	}
	const { DatabaseSync } = mod;
	return {
		async query(path, sql, params = []) {
			const db = new DatabaseSync(path, { readOnly: true });
			try {
				return db.prepare(sql).all(...params) as SqliteRow[];
			} finally {
				db.close();
			}
		},
	};
}
