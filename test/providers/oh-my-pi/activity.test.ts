import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLocalFs } from '../../../src/helpers/fs.js';
import { createLocalSqlite } from '../../../src/helpers/sqlite.js';
import type { Fs, Sqlite } from '../../../src/helpers/types.js';
import { type AgentsError, AllYourAgents, type Provider } from '../../../src/index.js';
import { ohMyPi } from '../../../src/providers/oh-my-pi/index.js';
import { sleep, waitFor } from '../../util/wait.js';
import {
	A,
	appendTranscript,
	assistant,
	B,
	fakeOmpProcesses,
	header,
	launch,
	marker,
	modelChange,
	slot,
	titleChange,
	toolCall,
	toolResult,
	user,
	withHome,
	writeBreadcrumb,
	writeTranscript,
} from './home.js';

type Procs = ReturnType<typeof fakeOmpProcesses>;

function observe(home: string, procs: Procs, opts: { fs?: Fs; sqlite?: Sqlite | false } = {}) {
	const aya = AllYourAgents({
		providers: [ohMyPi({ home })],
		processes: procs,
		debounce: { quietMs: 10 },
		...opts,
	});
	const errors: string[] = [];
	aya.on('error', (e) => errors.push(String(e.source === 'provider' ? e.error : e.event)));
	const live = (id: string) => aya.running().find((s) => s.id === id);
	return { aya, errors, live };
}

/** omp's prompt history: a WAL database the process keeps open, one row per submitted prompt. */
async function historyWriter(
	home: string,
	schema = 'prompt TEXT, created_at INTEGER, cwd TEXT, session_id TEXT',
) {
	await mkdir(join(home, 'agent'), { recursive: true });
	const db = join(home, 'agent', 'history.db');
	const child = spawn('sqlite3', [db], { stdio: ['pipe', 'ignore', 'inherit'] });
	const run = (sql: string) => child.stdin.write(`${sql}\n`);
	run(
		`pragma journal_mode=wal; create table history(id INTEGER PRIMARY KEY AUTOINCREMENT, ${schema});`,
	);
	const fs = createLocalFs();
	const started = Date.now();
	while (Date.now() - started < 3000 && !(await fs.stat(`${db}-wal`))) await sleep(30);
	return {
		submit: (sessionId: string, prompt: string) =>
			run(
				`insert into history(prompt, created_at, cwd, session_id) values('${prompt}', ${Math.floor(Date.now() / 1000)}, '/tmp/app', '${sessionId}');`,
			),
		run,
		close: () => child.stdin.end(),
	};
}

test('first prompt of a new session: running, and titled, before any transcript exists', async (t) => {
	if (!(await createLocalSqlite())) return t.skip('this Node has no built-in SQLite');
	await withHome(async (home) => {
		const history = await historyWriter(home);
		try {
			history.submit(B, 'an old prompt from before we started');
			await sleep(100);
			const procs = fakeOmpProcesses();
			const { aya, errors, live } = observe(home, procs);
			let started = 0;
			aya.on('session:status', (s) => {
				if (s.id === A && s.status === 'running') started++;
			});
			await aya.start();
			const path = await launch(home, procs, { id: A, pid: 200, terminal: 'ttys200', fresh: true });
			await launch(home, procs, { id: B, pid: 201, terminal: 'ttys201', fresh: true });
			await waitFor(() => live(A) && live(B));
			assert.equal(live(B)?.status, 'idle', 'rows present at start begin nothing');

			history.submit(A, 'Write a story about a lighthouse keeper');
			history.submit('00000000-0000-4000-8000-0000000000ff', 'someone else');
			await waitFor(() => live(A)?.status === 'running');
			assert.equal(live(A)?.title, 'Write a story about a lighthouse keeper');
			assert.equal(live(B)?.status, 'idle');

			// The transcript then appears, holding that same prompt and the finished reply.
			await writeTranscript(path, [
				slot(),
				header(A),
				user('Write a story about a lighthouse keeper'),
				assistant('stop'),
			]);
			await writeBreadcrumb(home, 'ttys200', path);
			await waitFor(() => live(A)?.status === 'idle');
			assert.equal(live(A)?.activity.lastTurn, 'completed');
			assert.equal(started, 1, 'one turn, not two');

			// Once there is a transcript, it is the record: a history row adds nothing.
			history.submit(A, 'second prompt');
			await sleep(150);
			assert.equal(live(A)?.status, 'idle');
			await appendTranscript(path, [user('second prompt')]);
			await waitFor(() => live(A)?.status === 'running');
			assert.deepEqual(errors, []);
			await aya.stop();
		} finally {
			history.close();
		}
	});
});

test('a prompt typed before keeps its row id, and still starts the first turn', async (t) => {
	if (!(await createLocalSqlite())) return t.skip('this Node has no built-in SQLite');
	await withHome(async (home) => {
		const history = await historyWriter(
			home,
			'prompt TEXT NOT NULL UNIQUE, created_at INTEGER, cwd TEXT, session_id TEXT',
		);
		// omp's own upsert: the row keeps its id, and only moves its time and session.
		const upsert = (sessionId: string, prompt: string) =>
			history.run(
				`insert into history(prompt, created_at, cwd, session_id) values('${prompt}', ${Math.floor(Date.now() / 1000)}, '/tmp/app', '${sessionId}') on conflict(prompt) do update set created_at = excluded.created_at, cwd = excluded.cwd, session_id = excluded.session_id;`,
			);
		try {
			upsert(B, 'commit');
			await sleep(100);
			const procs = fakeOmpProcesses();
			const { aya, errors, live } = observe(home, procs);
			await aya.start();
			await launch(home, procs, { id: A, pid: 210, terminal: 'ttys210', fresh: true });
			await waitFor(() => live(A));
			assert.equal(live(A)?.status, 'idle');
			upsert(A, 'commit');
			await waitFor(() => live(A)?.status === 'running');
			assert.equal(live(A)?.title, 'commit');
			assert.deepEqual(errors, []);
			await aya.stop();
		} finally {
			history.close();
		}
	});
});

test('first turn that fails ends failed with the provider message', async (t) => {
	if (!(await createLocalSqlite())) return t.skip('this Node has no built-in SQLite');
	await withHome(async (home) => {
		const history = await historyWriter(home);
		try {
			const procs = fakeOmpProcesses();
			const { aya, live } = observe(home, procs);
			await aya.start();
			const path = await launch(home, procs, { id: A, pid: 210, terminal: 'ttys210', fresh: true });
			await waitFor(() => live(A));
			history.submit(A, 'go');
			await waitFor(() => live(A)?.status === 'running');
			await writeTranscript(path, [
				slot(),
				header(A),
				user('go'),
				assistant('error', [], { errorMessage: 'rate limited' }),
			]);
			await waitFor(() => live(A)?.activity.lastTurn === 'failed');
			assert.equal(live(A)?.activity.error, 'rate limited');
			await aya.stop();
		} finally {
			history.close();
		}
	});
});

test('no SQLite reader: no error, idle until the transcript appears', async () => {
	await withHome(async (home) => {
		const procs = fakeOmpProcesses();
		await mkdir(join(home, 'agent'), { recursive: true });
		await writeFile(join(home, 'agent', 'history.db'), 'never opened');
		const { aya, errors, live } = observe(home, procs, { sqlite: false });
		await aya.start();
		const path = await launch(home, procs, { id: A, pid: 220, terminal: 'ttys220', fresh: true });
		await waitFor(() => live(A));
		assert.equal(live(A)?.status, 'idle');
		await writeTranscript(path, [slot(), header(A), user('go')]);
		await waitFor(() => live(A)?.status === 'running');
		assert.deepEqual(errors, []);
		await aya.stop();
	});
});

test('history schema changed: one error, first-turn detection off, files still observed', async (t) => {
	if (!(await createLocalSqlite())) return t.skip('this Node has no built-in SQLite');
	await withHome(async (home) => {
		const history = await historyWriter(home, 'text TEXT, at INTEGER');
		try {
			const procs = fakeOmpProcesses();
			const opened: string[] = [];
			const real = await createLocalSqlite();
			const sqlite: Sqlite = {
				query: (path, sql, params) => {
					opened.push(path);
					return (real as Sqlite).query(path, sql, params);
				},
			};
			const { aya, errors, live } = observe(home, procs, { sqlite });
			await aya.start();
			const path = await launch(home, procs, { id: A, pid: 230, terminal: 'ttys230', fresh: true });
			await waitFor(() => live(A));
			history.run(`insert into history(text, at) values('x', 1);`);
			history.run(`insert into history(text, at) values('y', 2);`);
			await waitFor(() => errors.length > 0);
			await sleep(150);
			assert.equal(errors.length, 1);
			await writeTranscript(path, [slot(), header(A), user('go')]);
			await waitFor(() => live(A)?.status === 'running');
			assert.ok(
				opened.every((p) => p.endsWith('history.db')),
				opened.join(' '),
			);
			await aya.stop();
		} finally {
			history.close();
		}
	});
});

test('replay at bind is silent: forty finished turns, one activity event', async () => {
	await withHome(async (home) => {
		const procs = fakeOmpProcesses();
		const records: unknown[] = [modelChange('xai-oauth/grok-4.6')];
		for (let i = 0; i < 40; i++) records.push(user(`prompt ${i}`), assistant('stop'));
		await launch(home, procs, { id: A, pid: 240, terminal: 'ttys240', records });
		const { aya, live } = observe(home, procs);
		let activity = 0;
		aya.on('session:activity', () => activity++);
		await aya.start();
		assert.equal(activity, 1);
		assert.equal(live(A)?.activity.lastTurn, 'completed');
		assert.equal(live(A)?.model, 'xai-oauth/grok-4.6', 'model is known by ready');
		assert.equal(live(A)?.title, 'prompt 0');
		await aya.stop();
	});
});

test('a turn left open by a killed process is interrupted; a failed turn keeps its error', async () => {
	await withHome(async (home) => {
		const procs = fakeOmpProcesses(Date.now() - 1000);
		const longAgo = Date.now() - 3600_000;
		await launch(home, procs, {
			id: A,
			pid: 250,
			terminal: 'ttys250',
			records: [user('never answered', longAgo)],
		});
		const path = await launch(home, procs, {
			id: B,
			pid: 251,
			terminal: 'ttys251',
			records: [user('x'), assistant('error', [], { errorMessage: 'boom' })],
		});
		const { aya, live } = observe(home, procs);
		await aya.start();
		assert.equal(live(A)?.status, 'idle');
		assert.equal(live(A)?.activity.lastTurn, 'interrupted');
		assert.equal(live(B)?.activity.error, 'boom');
		await appendTranscript(path, [user('try again')]);
		await waitFor(() => live(B)?.status === 'running');
		assert.equal(live(B)?.activity.error, undefined);
		await aya.stop();
	});
});

test('live tools, the ask wait, titles and a model switch', async () => {
	await withHome(async (home) => {
		const procs = fakeOmpProcesses();
		const { aya, live } = observe(home, procs);
		const waits: (string | undefined)[] = [];
		aya.on('session:status', (s) => waits.push(s.status === 'waiting' ? s.waitingFor : s.status));
		await aya.start();
		const path = await launch(home, procs, { id: A, pid: 260, terminal: 'ttys260', records: [] });
		await waitFor(() => live(A));
		await appendTranscript(path, [
			user('do it'),
			assistant('toolUse', [toolCall('t1', 'bash')]),
			marker('t1', 'bash'),
		]);
		await waitFor(() => live(A)?.activity.tool?.id === 't1');
		assert.equal(live(A)?.activity.tool?.name, 'bash');
		assert.equal(live(A)?.title, 'do it');
		await appendTranscript(path, [
			toolResult('t1', 'bash'),
			assistant('toolUse', [toolCall('a1', 'ask')]),
			marker('a1', 'ask'),
		]);
		await waitFor(() => live(A)?.status === 'waiting');
		assert.equal(live(A)?.waitingFor, 'ask');
		await appendTranscript(path, [toolResult('a1', 'ask'), titleChange('Generated title')]);
		await waitFor(() => live(A)?.title === 'Generated title');
		assert.equal(live(A)?.status, 'running');
		await appendTranscript(path, [
			titleChange('My title', 'user'),
			titleChange('Another generated one'),
			assistant('stop', undefined, { provider: 'anthropic', model: 'opus' }),
		]);
		await waitFor(() => live(A)?.status === 'idle');
		assert.equal(live(A)?.title, 'My title', 'a user title is not replaced by a generated one');
		assert.equal(live(A)?.model, 'anthropic/opus');
		assert.ok(waits.includes('ask'));
		await aya.stop();
	});
});

test('one bad record is reported and the tail goes on', async () => {
	await withHome(async (home) => {
		const procs = fakeOmpProcesses();
		const real = ohMyPi({ home });
		// The core never throws from emit. This stands in for any failure inside the handler.
		const failing: Provider = {
			...real,
			watch: (ctx) =>
				real.watch({
					...ctx,
					emit: ((event: string, payload: { id?: string }) => {
						if (event === 'turn' && payload.id === 'bad') throw new Error('cannot handle');
						(ctx.emit as (e: string, p: unknown) => void)(event, payload);
					}) as typeof ctx.emit,
				}),
		};
		const aya = AllYourAgents({
			providers: [failing],
			processes: procs,
			debounce: { quietMs: 10 },
		});
		const errors: AgentsError[] = [];
		aya.on('error', (e) => errors.push(e));
		await aya.start();
		const path = await launch(home, procs, {
			id: A,
			pid: 270,
			terminal: 'ttys270',
			records: [user('x')],
		});
		await waitFor(() => aya.running().length === 1);
		await appendTranscript(path, [assistant('toolUse', [toolCall('bad', 'bash')])]);
		await waitFor(() => errors.length === 1);
		await appendTranscript(path, [assistant('toolUse', [toolCall('t9', 'read')])]);
		await waitFor(() => aya.running()[0]?.activity.tool?.id === 't9');
		const [error] = errors;
		assert.ok(error?.source === 'provider');
		assert.equal(error.provider, 'oh-my-pi');
		assert.equal(errors.length, 1);
		await aya.stop();
	});
});
