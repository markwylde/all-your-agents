import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLocalFs } from '../../../src/helpers/fs.js';
import { createLocalSqlite } from '../../../src/helpers/sqlite.js';
import { AllYourAgents } from '../../../src/index.js';
import { ohMyPi } from '../../../src/providers/oh-my-pi/index.js';
import { sqliteWriter } from '../../util/sqlite-writer.js';
import { sleep, waitFor } from '../../util/wait.js';
import {
	A,
	appendTranscript,
	artifacts,
	assistant,
	entry,
	fakeOmpProcesses,
	header,
	launch,
	marker,
	sessionPath,
	slot,
	toolCall,
	toolResult,
	user,
	withHome,
	writeBreadcrumb,
	writeTranscript,
} from './home.js';

test('the local filesystem reports a new inode for a file replaced by rename', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'aya-ino-'));
	try {
		const fs = createLocalFs();
		const path = join(dir, 't.jsonl');
		await writeFile(path, 'one\n');
		const before = await fs.stat(path);
		await writeFile(path, 'one\ntwo\n');
		assert.equal((await fs.stat(path))?.ino, before?.ino, 'a rewrite in place keeps it');
		await writeFile(`${path}.tmp`, 'one\ntwo\nthree\n');
		await rename(`${path}.tmp`, path);
		const after = await fs.stat(path);
		assert.ok(before?.ino != null && after?.ino != null && after.ino !== before.ino);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('a moved session keeps its finished subagent finished and still follows a running one', async () => {
	await withHome(async (home) => {
		const procs = fakeOmpProcesses();
		const aya = AllYourAgents({
			providers: [ohMyPi({ home })],
			processes: procs,
			debounce: { quietMs: 10 },
		});
		const events: string[] = [];
		aya.on('subagent:start', (s) => events.push(`start:${s.id}`));
		aya.on('subagent:end', (s) => events.push(`end:${s.id}:${s.status}`));
		aya.on('session:close', () => events.push('close'));
		await aya.start();
		const from = await launch(home, procs, {
			id: A,
			pid: 400,
			terminal: 'ttys400',
			records: [user('go')],
		});
		// Children present at bind would be seeded silently; these appear on our watch.
		await waitFor(() => aya.running().length === 1);
		const child = (parent: string, n: number) => [
			slot(),
			header(`00000000-0000-4000-9000-00000000000${n}`, { parentSession: parent }),
			entry('session_init', { agent: 'sonic' }),
			user('task'),
		];
		const done = (name: string) => [
			assistant('toolUse', [toolCall(`y-${name}`, 'yield')]),
			marker(`y-${name}`, 'yield'),
			toolResult(`y-${name}`, 'yield', { status: 'success' }),
		];
		await writeTranscript(join(artifacts(from), 'Done.jsonl'), [
			...child(from, 1),
			...done('Done'),
		]);
		await writeTranscript(join(artifacts(from), 'Still.jsonl'), child(from, 2));
		await waitFor(
			() => events.includes('end:Done:completed') && events.includes('start:Still'),
		).catch(() => assert.fail(`first wait: ${events.join(' | ')}`));

		const to = sessionPath(home, A, '/tmp/moved');
		await mkdir(join(to, '..'), { recursive: true });
		await rename(from, to);
		await rename(artifacts(from), artifacts(to));
		await writeBreadcrumb(home, 'ttys400', to, { cwd: '/tmp/moved' });
		await sleep(200);
		await appendTranscript(join(artifacts(to), 'Still.jsonl'), done('Still'));
		await waitFor(() => events.includes('end:Still:completed')).catch(() =>
			assert.fail(`after the move: ${events.join(' | ')}`),
		);
		assert.deepEqual(events.slice().sort(), [
			'end:Done:completed',
			'end:Still:completed',
			'start:Done',
			'start:Still',
		]);
		await aya.stop();
	});
});

test('history rebuilt with lower ids: the cursor resets, nothing old is replayed, new rows count', async (t) => {
	if (!(await createLocalSqlite())) return t.skip('this Node has no built-in SQLite');
	await withHome(async (home) => {
		await mkdir(join(home, 'agent'), { recursive: true });
		const db = join(home, 'agent', 'history.db');
		const child = sqliteWriter(db);
		const run = (sql: string) => child.stdin.write(`${sql}\n`);
		const submit = (id: string, prompt: string) =>
			run(
				`insert into history(prompt, created_at, cwd, session_id) values('${prompt}', 1, '/tmp/app', '${id}');`,
			);
		run(
			'pragma journal_mode=wal; create table history(id INTEGER PRIMARY KEY AUTOINCREMENT, prompt TEXT, created_at INTEGER, cwd TEXT, session_id TEXT);',
		);
		for (let i = 0; i < 5; i++) submit('00000000-0000-4000-8000-0000000000ff', `old ${i}`);
		try {
			const fs = createLocalFs();
			const started = Date.now();
			while (Date.now() - started < 3000 && !(await fs.stat(`${db}-wal`))) await sleep(30);
			await sleep(100);
			const procs = fakeOmpProcesses();
			const aya = AllYourAgents({
				providers: [ohMyPi({ home })],
				processes: procs,
				debounce: { quietMs: 10 },
			});
			const errors: unknown[] = [];
			aya.on('error', (e) => errors.push(e));
			await aya.start();
			await launch(home, procs, { id: A, pid: 410, terminal: 'ttys410', fresh: true });
			await waitFor(() => aya.running().length === 1);
			// omp's history GC: the table is rebuilt and ids start again below our cursor.
			run(`delete from history; delete from sqlite_sequence where name='history';`);
			submit('00000000-0000-4000-8000-0000000000ff', 'rebuilt row');
			await sleep(200);
			assert.equal(aya.running()[0]?.status, 'idle');
			submit(A, 'a real first prompt');
			await waitFor(() => aya.running()[0]?.status === 'running');
			assert.equal(aya.running()[0]?.title, 'a real first prompt');
			assert.deepEqual(errors, []);
			await aya.stop();
		} finally {
			child.stdin.end();
		}
	});
});
