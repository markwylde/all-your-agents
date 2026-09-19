import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FakeClock } from '../../../src/helpers/clock.js';
import { createLocalFs } from '../../../src/helpers/fs.js';
import { AllYourAgents } from '../../../src/index.js';
import { codexCli } from '../../../src/providers/codex-cli/index.js';
import { sleep, waitFor } from '../../util/wait.js';
import {
	A,
	B,
	eventMsg,
	fakeCodexProcesses,
	responseItem,
	rolloutPath,
	sessionMeta,
	writeLock,
	writeRollout,
} from './home.js';

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
	const home = await mkdtemp(join(tmpdir(), 'aya-codex-'));
	try {
		await fn(home);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

test('held files bind; subagent is not a root; auth/sqlite never read', async () => {
	await withHome(async (home) => {
		const start = Date.now() - 1000;
		const procs = fakeCodexProcesses(start);
		procs.set(11, true, start);
		const path = rolloutPath(home, A);
		await writeRollout(path, [
			sessionMeta(A, {}, new Date().toISOString()),
			eventMsg('task_started'),
		]);
		procs.hold(11, path);
		const child = rolloutPath(home, B);
		await writeRollout(child, [
			sessionMeta(B, {
				parent_thread_id: A,
				thread_source: 'subagent',
				source: { subagent: {} },
			}),
		]);
		procs.hold(11, child);
		await writeFile(join(home, 'auth.json'), '{"token":"x"}');
		const reads: string[] = [];
		const inner = createLocalFs();
		const fs = {
			...inner,
			async readFile(p: string, opts?: { maxBytes?: number }) {
				reads.push(p);
				return inner.readFile(p, opts);
			},
			async readRange(p: string, s: number, e?: number) {
				reads.push(p);
				return inner.readRange(p, s, e);
			},
		};
		const aya = AllYourAgents({
			providers: [codexCli({ home })],
			processes: procs,
			fs,
			debounce: { quietMs: 10 },
		});
		const events: string[] = [];
		aya.on('session:create', (s) => events.push(`create:${s.id}`));
		aya.on('session:open', (s) => events.push(`open:${s.id}`));
		await aya.start();
		assert.ok(events.some((e) => e.endsWith(A)));
		assert.equal(
			events.some((e) => e.endsWith(B)),
			false,
		);
		assert.deepEqual(
			reads.filter((p) => /auth\.json$|sqlite|chat_processes|ipc/.test(p)),
			[],
		);
		await aya.stop();
	});
});

test('create after start; conversation switch re-probes A with no event on A', async () => {
	await withHome(async (home) => {
		const start = Date.now() - 1000;
		const procs = fakeCodexProcesses(start);
		procs.set(9, true, start);
		const aya = AllYourAgents({
			providers: [codexCli({ home })],
			processes: procs,
			debounce: { quietMs: 10 },
		});
		const events: string[] = [];
		aya.on('session:create', (s) => events.push(`create:${s.id}`));
		aya.on('session:open', (s) => events.push(`open:${s.id}`));
		aya.on('session:close', (s) => events.push(`close:${s.id}`));
		await aya.start();
		const aPath = rolloutPath(home, A);
		await writeRollout(aPath, [sessionMeta(A)]);
		procs.hold(9, aPath);
		await waitFor(() => events.includes(`create:${A}`));
		const bPath = rolloutPath(home, B);
		procs.drop(9, aPath);
		await writeRollout(bPath, [sessionMeta(B)]);
		procs.hold(9, bPath);
		await waitFor(() => events.includes(`close:${A}`) && events.includes(`create:${B}`));
		assert.ok(
			events.indexOf(`close:${A}`) < events.indexOf(`create:${B}`) || events.includes(`close:${A}`),
		);
		await aya.stop();
	});
});

test('quietly dropped rollout stays live until reconcile; no timer', async () => {
	await withHome(async (home) => {
		const start = Date.now() - 1000;
		const procs = fakeCodexProcesses(start);
		procs.set(3, true, start);
		const path = rolloutPath(home, A);
		await writeRollout(path, [sessionMeta(A)]);
		procs.hold(3, path);
		const clock = new FakeClock();
		const aya = AllYourAgents({
			providers: [codexCli({ home })],
			processes: procs,
			debounce: { quietMs: 10, clock },
		});
		await aya.start();
		await waitFor(() => aya.running().some((s) => s.id === A));
		procs.drop(3, path);
		clock.advance(60_000);
		assert.ok(aya.running().some((s) => s.id === A));
		await aya.reconcile(3);
		await waitFor(() => !aya.running().some((s) => s.id === A));
		await aya.stop();
	});
});

test('kill -9 closes via watchProcess; missing holders yields no live rows', async () => {
	await withHome(async (home) => {
		const start = Date.now() - 1000;
		const procs = fakeCodexProcesses(start);
		procs.set(4, true, start);
		const path = rolloutPath(home, A);
		await writeRollout(path, [sessionMeta(A)]);
		procs.hold(4, path);
		const aya = AllYourAgents({
			providers: [codexCli({ home })],
			processes: procs,
			debounce: { quietMs: 10 },
		});
		const events: string[] = [];
		aya.on('session:close', (s) => events.push(`close:${s.id}`));
		await aya.start();
		await waitFor(() => aya.running().some((s) => s.id === A));
		procs.fire(4);
		await waitFor(() => events.includes(`close:${A}`));
		await aya.stop();

		const none = AllYourAgents({
			providers: [codexCli({ home })],
			processes: {
				info: async () => ({ alive: true, startTime: start }),
				watch: () => ({ stop() {} }),
			},
			debounce: { quietMs: 10 },
		});
		await none.start();
		await sleep(40);
		assert.equal(none.running().length, 0);
		await none.stop();
	});
});

test('append after start opens a resume; user prompt titles', async () => {
	await withHome(async (home) => {
		const start = Date.now() - 1000;
		const procs = fakeCodexProcesses(start);
		procs.set(5, true, start);
		const path = rolloutPath(home, A);
		// A resumed thread's session_meta predates the resuming process.
		await writeRollout(path, [sessionMeta(A, {}, new Date(start - 86_400_000).toISOString())]);
		const aya = AllYourAgents({
			providers: [codexCli({ home })],
			processes: procs,
			debounce: { quietMs: 10 },
		});
		const events: string[] = [];
		aya.on('session:open', (s) => events.push(`open:${s.id}`));
		await aya.start();
		procs.hold(5, path);
		const { appendFile } = await import('node:fs/promises');
		await appendFile(
			path,
			`${JSON.stringify(responseItem({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello there' }] }))}\n`,
		);
		await waitFor(() => events.includes(`open:${A}`));
		await waitFor(() => aya.running().some((s) => s.title === 'Hello there'));
		await aya.stop();
	});
});

test('resume after start is seen from its thread lock, before any append', async () => {
	await withHome(async (home) => {
		const start = Date.now() - 1000;
		const procs = fakeCodexProcesses(start);
		procs.set(6, true, start);
		const path = rolloutPath(home, A);
		await writeRollout(path, [sessionMeta(A, {}, new Date(start - 86_400_000).toISOString())]);
		const aya = AllYourAgents({
			providers: [codexCli({ home })],
			processes: procs,
			debounce: { quietMs: 10 },
		});
		const events: string[] = [];
		aya.on('session:open', (s) => events.push(`open:${s.id}:${s.pid}`));
		await aya.start();
		const lock = await writeLock(home, A);
		procs.hold(6, lock);
		await waitFor(() => events.includes(`open:${A}:6`));
		await aya.stop();
	});
});

test('quit then resume again is seen from a recreated thread lock', async () => {
	await withHome(async (home) => {
		const start = Date.now() - 1000;
		const procs = fakeCodexProcesses(start);
		procs.set(7, true, start);
		const path = rolloutPath(home, A);
		await writeRollout(path, [sessionMeta(A, {}, new Date(start - 86_400_000).toISOString())]);
		procs.hold(7, path);
		const aya = AllYourAgents({
			providers: [codexCli({ home })],
			processes: procs,
			debounce: { quietMs: 10 },
		});
		const events: string[] = [];
		aya.on('session:open', (s) => events.push(`open:${s.pid}`));
		aya.on('session:close', () => events.push('close'));
		await aya.start();
		await waitFor(() => events.includes('open:7'));
		// A TUI leaves its unheld lock behind; the next Codex deletes and recreates it.
		const lock = await writeLock(home, A);
		procs.drop(7, path);
		procs.set(7, false);
		procs.fire(7);
		await waitFor(() => events.includes('close'));
		procs.set(8, true, Date.now());
		await rm(lock);
		await writeLock(home, A);
		procs.hold(8, lock);
		await waitFor(() => events.includes('open:8'));
		await aya.stop();
	});
});

test('a lock for a thread with no rollout yet binds nothing', async () => {
	await withHome(async (home) => {
		const procs = fakeCodexProcesses();
		procs.set(9, true);
		const aya = AllYourAgents({
			providers: [codexCli({ home })],
			processes: procs,
			debounce: { quietMs: 10 },
		});
		await aya.start();
		procs.hold(9, await writeLock(home, A));
		await sleep(100);
		assert.equal(aya.running().length, 0);
		await aya.stop();
	});
});

test('two sessions one pid; resume at start; missing home then created', async () => {
	await withHome(async (home) => {
		const start = Date.now() - 1000;
		const procs = fakeCodexProcesses(start);
		procs.set(2, true, start);
		const aPath = rolloutPath(home, A);
		const bPath = rolloutPath(home, B);
		await writeRollout(aPath, [sessionMeta(A, {}, new Date(start - 86_400_000).toISOString())]);
		await writeRollout(bPath, [sessionMeta(B)]);
		procs.hold(2, aPath);
		procs.hold(2, bPath);
		const aya = AllYourAgents({
			providers: [codexCli({ home })],
			processes: procs,
			debounce: { quietMs: 10 },
		});
		await aya.start();
		await waitFor(() => aya.running().filter((s) => s.id === A || s.id === B).length === 2);
		await aya.stop();
	});

	const missing = await mkdtemp(join(tmpdir(), 'aya-codex-miss-'));
	try {
		const start = Date.now() - 1000;
		const procs = fakeCodexProcesses(start);
		procs.set(1, true, start);
		const aya = AllYourAgents({
			providers: [codexCli({ home: missing })],
			processes: procs,
			debounce: { quietMs: 10 },
		});
		await aya.start();
		const path = rolloutPath(missing, A);
		await writeRollout(path, [sessionMeta(A)]);
		procs.hold(1, path);
		await waitFor(() => aya.running().some((s) => s.id === A));
		await aya.stop();
	} finally {
		await rm(missing, { recursive: true, force: true });
	}
});

test('revert suffix relocates without close or second create', async () => {
	await withHome(async (home) => {
		const start = Date.now() - 1000;
		const procs = fakeCodexProcesses(start);
		procs.set(8, true, start);
		const extra = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
		const oldPath = rolloutPath(home, A);
		await writeRollout(oldPath, [
			sessionMeta(A),
			eventMsg('task_complete'),
			responseItem({
				type: 'message',
				role: 'user',
				content: [{ type: 'input_text', text: 'hi' }],
			}),
		]);
		procs.hold(8, oldPath);
		const aya = AllYourAgents({
			providers: [codexCli({ home })],
			processes: procs,
			debounce: { quietMs: 10 },
		});
		const events: string[] = [];
		aya.on('session:create', (s) => events.push(`create:${s.id}`));
		aya.on('session:close', (s) => events.push(`close:${s.id}`));
		aya.on('session:open', (s) => events.push(`open:${s.id}`));
		await aya.start();
		await waitFor(() => aya.running().some((s) => s.id === A));
		const newPath = rolloutPath(home, A, '2026-01-01T00-00-00', extra);
		await rename(oldPath, newPath);
		procs.drop(8, oldPath);
		procs.hold(8, newPath);
		await appendFile(
			newPath,
			`${JSON.stringify(eventMsg('thread_settings_applied', { thread_settings: { cwd: '/tmp/moved' } }))}\n`,
		);
		await waitFor(() => aya.running().some((s) => s.id === A && s.cwd === '/tmp/moved'));
		assert.equal(events.filter((e) => e.startsWith('close:')).length, 0);
		assert.equal(events.filter((e) => e === `create:${A}`).length, 0);
		assert.equal(aya.running().filter((s) => s.id === A).length, 1);
		await aya.stop();
	});
});

test('closed exec session remains in history for sessions({ since })', async () => {
	await withHome(async (home) => {
		const start = Date.now() - 1000;
		const procs = fakeCodexProcesses(start);
		procs.set(3, true, start);
		const path = rolloutPath(home, A);
		await writeRollout(path, [
			sessionMeta(A, { source: 'exec', originator: 'codex_exec' }),
			eventMsg('task_started'),
		]);
		procs.hold(3, path);
		const aya = AllYourAgents({
			providers: [codexCli({ home })],
			processes: procs,
			debounce: { quietMs: 10 },
		});
		await aya.start();
		await waitFor(() => aya.running().some((s) => s.id === A && s.kind === 'headless'));
		assert.ok(aya.running()[0]?.startedAt != null);
		procs.fire(3);
		await waitFor(() => aya.running().length === 0);
		const since = Date.now() - 60_000;
		const listed = await aya.sessions({ since });
		assert.ok(listed.some((s) => s.id === A && s.harness === 'Codex' && s.kind === 'headless'));
		await aya.stop();
	});
});

test('stale file later held by a new process rebinds', async () => {
	await withHome(async (home) => {
		const start = Date.now() - 1000;
		const procs = fakeCodexProcesses(start);
		procs.set(4, true, start);
		const path = rolloutPath(home, A);
		await writeRollout(path, [sessionMeta(A, {}, new Date(start + 100).toISOString())]);
		procs.hold(4, path);
		const aya = AllYourAgents({
			providers: [codexCli({ home })],
			processes: procs,
			debounce: { quietMs: 10 },
		});
		const events: string[] = [];
		aya.on('session:close', (s) => events.push(`close:${s.id}`));
		aya.on('session:open', (s) => events.push(`open:${s.id}`));
		await aya.start();
		await waitFor(() => aya.running().some((s) => s.id === A));
		procs.fire(4);
		await waitFor(() => events.includes(`close:${A}`));
		procs.drop(4, path);
		const later = Date.now();
		procs.set(9, true, later);
		procs.hold(9, path);
		await appendFile(path, `${JSON.stringify(eventMsg('token_count'))}\n`);
		await waitFor(() => aya.running().some((s) => s.id === A && s.pid === 9));
		await aya.stop();
	});
});

test('meta arriving on change of a new file is create, not open', async () => {
	await withHome(async (home) => {
		const start = Date.now() - 1000;
		const procs = fakeCodexProcesses(start);
		procs.set(2, true, start);
		const aya = AllYourAgents({
			providers: [codexCli({ home })],
			processes: procs,
			debounce: { quietMs: 10 },
		});
		const events: string[] = [];
		aya.on('session:create', (s) => events.push(`create:${s.id}`));
		aya.on('session:open', (s) => events.push(`open:${s.id}`));
		await aya.start();
		const path = rolloutPath(home, A);
		await mkdir(join(path, '..'), { recursive: true });
		await writeFile(path, '');
		procs.hold(2, path);
		await appendFile(path, `${JSON.stringify(sessionMeta(A))}\n`);
		await waitFor(() => events.includes(`create:${A}`));
		assert.equal(
			events.some((e) => e === `open:${A}`),
			false,
		);
		await aya.stop();
	});
});

test('append to a known child does not call holders', async () => {
	await withHome(async (home) => {
		const start = Date.now() - 1000;
		const procs = fakeCodexProcesses(start);
		procs.set(8, true, start);
		let holderCalls = 0;
		const inner = procs.holders?.bind(procs);
		procs.holders = async (path) => {
			holderCalls++;
			return inner ? inner(path) : [];
		};
		const parent = rolloutPath(home, A);
		const child = rolloutPath(home, B);
		await writeRollout(parent, [sessionMeta(A), eventMsg('task_started')]);
		await writeRollout(child, [
			sessionMeta(B, {
				parent_thread_id: A,
				thread_source: 'subagent',
				source: { subagent: {} },
				agent_nickname: 'Parfit',
			}),
			eventMsg('task_started'),
		]);
		procs.hold(8, parent);
		procs.hold(8, child);
		const aya = AllYourAgents({
			providers: [codexCli({ home })],
			processes: procs,
			debounce: { quietMs: 10 },
		});
		const ends: string[] = [];
		aya.on('subagent:end', (s) => ends.push(`${s.id}:${s.status}`));
		await aya.start();
		await waitFor(() => aya.running().some((s) => s.id === A));
		const before = holderCalls;
		await appendFile(child, `${JSON.stringify(eventMsg('task_complete'))}\n`);
		await waitFor(() => ends.includes(`${B}:completed`));
		assert.equal(holderCalls, before);
		await aya.stop();
	});
});
