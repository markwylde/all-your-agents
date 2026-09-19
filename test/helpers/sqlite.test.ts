import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLocalProcesses } from '../../src/helpers/processes.js';
import { createLocalSqlite } from '../../src/helpers/sqlite.js';
import type { SqliteRow } from '../../src/helpers/types.js';
import { sqliteWriter } from '../util/sqlite-writer.js';
import { sleep } from '../util/wait.js';

/** A long-lived writer, like a harness holding its database open in WAL mode. */
function writer(db: string) {
	const child = sqliteWriter(db);
	const run = (sql: string) => child.stdin.write(`${sql}\n`);
	run('pragma journal_mode=wal; create table t(id integer primary key, v text);');
	return { child, run };
}

test('reads rows committed by a process that holds the database open in WAL mode', async (t) => {
	const sqlite = await createLocalSqlite();
	if (!sqlite) return t.skip('this Node has no built-in SQLite');
	const dir = await mkdtemp(join(tmpdir(), 'aya-sqlite-'));
	const db = join(dir, 'h.db');
	const w = writer(db);
	const procs = createLocalProcesses({ koffi: false });
	try {
		w.run(`insert into t(v) values('one');`);
		let rows: SqliteRow[] = [];
		const started = Date.now();
		while (Date.now() - started < 3000 && rows.length === 0) {
			rows = await sqlite.query(db, 'select id, v from t where id > ?', [0]).catch(() => []);
			if (rows.length === 0) await sleep(30);
		}
		assert.deepEqual({ ...rows[0] }, { id: 1, v: 'one' });
		// Our read did not block the writer, and we hold nothing afterwards.
		w.run(`insert into t(v) values('two');`);
		await sleep(200);
		const again = await sqlite.query(db, 'select v from t order by id');
		assert.deepEqual(
			again.map((row) => row.v),
			['one', 'two'],
		);
		assert.equal((await procs.holders?.(db))?.includes(process.pid) ?? false, false);
	} finally {
		w.child.stdin.end();
		await procs.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test('a runtime without SQLite yields no reader and does not throw', async () => {
	assert.equal(
		await createLocalSqlite(() => Promise.reject(new Error('no such module'))),
		undefined,
	);
	assert.equal(await createLocalSqlite(() => Promise.resolve({})), undefined);
});
