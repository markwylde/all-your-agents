import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLocalSqlite } from '../../src/helpers/sqlite.js';
import { AllYourAgents, antigravityCli } from '../../src/index.js';
import { databaseOf, lockOf } from '../../src/providers/antigravity-cli/data.js';
import { A, assistant, user } from '../providers/antigravity-cli/fixtures.js';
import { sqliteWriter } from '../util/sqlite-writer.js';
import { waitFor } from '../util/wait.js';

/** No credentials or model calls: exercise the real persisted agy 1.5.5 format and OS watches. */
test('agy SQLite/WAL, actual lock holder, history, mutable completion, exit and resume', async (t) => {
	if (!(await createLocalSqlite())) return t.skip('this Node has no built-in SQLite');
	const home = await mkdtemp(join(tmpdir(), 'aya-agy-e2e-'));
	await mkdir(join(home, 'conversations'));
	await mkdir(join(home, 'presence'));
	const writer = sqliteWriter(databaseOf(home, A));
	const owner = () =>
		spawn(
			process.execPath,
			[
				'-e',
				"const fs=require('node:fs'); const fd=fs.openSync(process.argv[1], 'a'); fs.futimesSync(fd,new Date(),new Date()); console.log('ready'); process.stdin.resume();",
				lockOf(home, A),
			],
			{ stdio: ['pipe', 'pipe', 'inherit'] },
		);
	let holder = owner();
	const aya = AllYourAgents({
		providers: [antigravityCli({ home })],
		debounce: { quietMs: 10, maxLatencyMs: 100 },
	});
	const errors: unknown[] = [];
	aya.on('error', (e) => errors.push(e));
	const lifecycle: string[] = [];
	aya.on('session:open', () => lifecycle.push('open'));
	aya.on('session:close', () => lifecycle.push('close'));
	try {
		await once(holder.stdout, 'data');
		await writer.run(
			`PRAGMA journal_mode=WAL; CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_format INTEGER, step_payload BLOB); ATTACH DATABASE '${join(home, 'conversation_summaries.db')}' AS catalog; PRAGMA catalog.journal_mode=WAL; CREATE TABLE catalog.conversation_summaries(conversation_id TEXT PRIMARY KEY,title TEXT,workspace_uris TEXT,status TEXT,parent_conversation_id TEXT,last_modified_time TEXT); INSERT INTO catalog.conversation_summaries VALUES('${A}','SQLite fixture','["file:///tmp/aya-project"]','CASCADE_RUN_STATUS_RUNNING','','2027-01-15 08:00:00+00:00');`,
		);
		const insert = async (raw: ReturnType<typeof user>) =>
			writer.run(
				`INSERT OR REPLACE INTO steps VALUES(${raw.idx},${raw.step_type},${raw.status},0,X'${Buffer.from(raw.step_payload as Uint8Array).toString('hex')}');`,
			);
		await insert(user());
		await insert(assistant(1, 2, 2));
		await aya.start();
		await waitFor(() => aya.running().some((s) => s.id === A));
		assert.equal(aya.running()[0]?.pid, holder.pid);
		assert.equal(aya.running()[0]?.status, 'running');
		assert.equal((await aya.sessions()).length, 1);
		const session = await aya.get(A);
		assert.ok(session);
		const stream = session.events(),
			iterator = stream[Symbol.asyncIterator]();
		assert.equal((await iterator.next()).value?.kind, 'user');
		const next = iterator.next();
		await insert(assistant());
		await writer.run("UPDATE catalog.conversation_summaries SET status='CASCADE_RUN_STATUS_IDLE';");
		assert.equal((await next).value?.kind, 'assistant');
		assert.equal((await iterator.next()).value?.kind, 'turn-end');
		const pending = iterator.next();
		stream.close();
		assert.equal((await pending).done, true);
		await waitFor(
			() =>
				aya.running()[0]?.activity.lastTurn === 'completed' && aya.running()[0]?.status === 'idle',
		);
		const turns = [];
		for await (const turn of session.transcript()) turns.push(turn);
		assert.equal(turns.length, 1);
		assert.equal(turns[0]?.outcome, 'completed');
		const exited = once(holder, 'exit');
		holder.stdin.end();
		await exited;
		// The optional process watcher can be unsupported; hosts can always reconcile.
		await aya.reconcile();
		await waitFor(() => aya.running().length === 0);
		holder = owner();
		await once(holder.stdout, 'data');
		await waitFor(() => aya.running()[0]?.pid === holder.pid);
		assert.deepEqual(lifecycle, ['open', 'close', 'open']);
		assert.equal(errors.length, 0);
	} finally {
		await aya.stop();
		holder.kill();
		writer.stdin.end();
		await rm(home, { recursive: true, force: true });
	}
});
