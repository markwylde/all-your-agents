import assert from 'node:assert/strict';
import { mkdtemp, open, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLocalFs } from '../../src/helpers/fs.js';
import { createLocalSqlite } from '../../src/helpers/sqlite.js';
import { watchFile } from '../../src/helpers/watch-file.js';
import { sqliteWriter } from '../util/sqlite-writer.js';
import { sleep, waitFor } from '../util/wait.js';

test('heldOpen reports commits to a WAL that another process keeps open', async (t) => {
	if (!(await createLocalSqlite())) return t.skip('this Node has no built-in SQLite');
	const dir = await mkdtemp(join(tmpdir(), 'aya-file-held-'));
	const db = join(dir, 'h.db');
	const child = sqliteWriter(db);
	const fs = createLocalFs();
	try {
		await child.run('pragma journal_mode=wal; create table t(a); insert into t values(0);');
		let held = 0;
		const w = watchFile(fs, `${db}-wal`, () => held++, { quietMs: 15, heldOpen: true });
		// Setup notifications can land late on a slow runner: count from a quiet baseline.
		let seen = -1;
		while (seen !== held) {
			seen = held;
			await sleep(200);
		}
		const before = held;
		for (let i = 1; i <= 5; i++) {
			await child.run(`insert into t values(${i});`);
			await sleep(60);
		}
		await waitFor(() => held > before);
		w.close();
		// Coalesced: at most one read per commit, however many notifications each raised.
		assert.ok(held - before <= 5, `reads ${held - before}`);
	} finally {
		child.stdin.end();
		await rm(dir, { recursive: true, force: true });
	}
});

test('heldOpen follows the path when the file is deleted and created again', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'aya-file-held-'));
	const path = join(dir, 'log.bin');
	await writeFile(path, 'a');
	try {
		const fs = createLocalFs();
		const events: string[] = [];
		const w = watchFile(fs, path, (e) => events.push(e.type), { quietMs: 15, heldOpen: true });
		await sleep(100);
		await unlink(path);
		await waitFor(() => events.includes('delete'));
		await writeFile(path, 'b');
		await waitFor(() => events.includes('change'));
		await sleep(150);
		const seen = events.length;
		// Written through a handle that stays open: only a watch on the new file sees this.
		const handle = await open(path, 'a');
		try {
			await handle.write('more');
			await handle.sync();
			await waitFor(() => events.length > seen);
		} finally {
			await handle.close();
		}
		w.close();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('without heldOpen only the parent directory is watched', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'aya-file-held-'));
	const path = join(dir, 'f.json');
	await writeFile(path, '{}');
	try {
		const local = createLocalFs();
		const spy = (into: string[]) => ({
			...local,
			watch: (p: string) => {
				into.push(p);
				return local.watch(p);
			},
		});
		const plain: string[] = [];
		const a = watchFile(spy(plain), path, () => {}, { quietMs: 15 });
		await sleep(50);
		a.close();
		assert.deepEqual(plain, [dir]);
		const both: string[] = [];
		const b = watchFile(spy(both), path, () => {}, { quietMs: 15, heldOpen: true });
		await sleep(50);
		b.close();
		assert.deepEqual(both.sort(), [dir, path].sort());
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
