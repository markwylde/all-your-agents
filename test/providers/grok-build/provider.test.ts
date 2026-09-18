import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FakeClock } from '../../../src/helpers/clock.js';
import { createLocalFs } from '../../../src/helpers/fs.js';
import type { Processes } from '../../../src/helpers/types.js';
import { AllYourAgents } from '../../../src/index.js';
import { grokBuild } from '../../../src/providers/grok-build/index.js';
import { sleep, waitFor } from '../../util/wait.js';
import { entry, fakeProcesses, makeSession, user, writeIndex } from './home.js';

const A = '01a0b474-0a8c-7002-b1fd-ff90b332cdc3';
const B = '01a0b474-0a8c-7002-b1fd-ff90b332cdc4';
const C = '01a0b474-0a8c-7002-b1fd-ff90b332cdc5';

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
	const home = await mkdtemp(join(tmpdir(), 'aya-grok-'));
	try {
		await fn(home);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

function record(aya: ReturnType<typeof AllYourAgents>): string[] {
	const events: string[] = [];
	aya.on('session:create', (s) => events.push(`create:${s.id}`));
	aya.on('session:open', (s) => events.push(`open:${s.id}`));
	aya.on('session:close', (s) => events.push(`close:${s.id}:${s.pid ?? ''}`));
	aya.on('session:status', (s) => events.push(`status:${s.id}:${s.status ?? ''}`));
	return events;
}

test('two sessions in one cwd bind separately; lock, tmp and auth are never read', async () => {
	await withHome(async (home) => {
		const start = Date.now() - 1000;
		const procs = fakeProcesses(start);
		procs.set(11, true, start);
		procs.set(12, true, start);
		const reads: string[] = [];
		const inner = createLocalFs();
		const fs = {
			...inner,
			async readFile(path: string, opts?: { maxBytes?: number }) {
				reads.push(path);
				return inner.readFile(path, opts);
			},
			async readRange(path: string, s: number, e?: number) {
				reads.push(path);
				return inner.readRange(path, s, e);
			},
		};
		await makeSession(home, '/tmp/app', A, { summary: { generated_title: 'Alpha' } });
		await writeIndex(home, [entry(A, 11), entry(B, 12)]);
		await writeFile(join(home, 'active_sessions.lock'), '');
		await writeFile(join(home, 'active_sessions.json.tmp'), '[]');
		await writeFile(join(home, 'auth.json'), '{"token":"secret"}');
		const aya = AllYourAgents({
			providers: [grokBuild({ home })],
			processes: procs,
			fs,
			debounce: { quietMs: 10 },
		});
		const events = record(aya);
		await aya.start();
		assert.ok(events.includes(`open:${A}`));
		assert.ok(events.includes(`create:${B}`));
		assert.equal(aya.running().find((s) => s.id === A)?.title, 'Alpha');
		await writeIndex(home, [entry(A, 11), entry(B, 12)]);
		await sleep(60);
		assert.deepEqual(
			reads.filter((p) => /\.lock$|\.tmp$|auth\.json$|sqlite/.test(p)),
			[],
		);
		await aya.stop();
	});
});

test('one pid with two sessions: removing one keeps the other; exit closes both', async () => {
	await withHome(async (home) => {
		const start = Date.now() - 1000;
		const procs = fakeProcesses(start);
		procs.set(7, true, start);
		let watches = 0;
		const counting: Processes = {
			info: procs.info,
			watch(pid, onExit) {
				watches++;
				return procs.watch(pid, onExit);
			},
		};
		await writeIndex(home, [entry(A, 7), entry(B, 7)]);
		const aya = AllYourAgents({
			providers: [grokBuild({ home })],
			processes: counting,
			debounce: { quietMs: 10 },
		});
		const events = record(aya);
		await aya.start();
		assert.deepEqual(
			aya
				.running()
				.map((s) => s.id)
				.sort(),
			[A, B],
		);
		assert.equal(watches, 1, 'one process watch per pid');
		await writeIndex(home, [entry(A, 7)]);
		await waitFor(() => events.includes(`close:${B}:`));
		assert.deepEqual(
			aya.running().map((s) => s.id),
			[A],
		);
		await writeIndex(home, [entry(A, 7), entry(C, 7)]);
		await waitFor(() => aya.running().length === 2);
		procs.fire(7);
		assert.deepEqual(aya.running(), []);
		assert.ok(events.includes(`close:${A}:`) && events.includes(`close:${C}:`));
		// The entries are still there: rewriting them does not bring them back.
		await writeIndex(home, JSON.parse(await readFile(join(home, 'active_sessions.json'), 'utf8')));
		await sleep(60);
		assert.equal(aya.running().length, 0);
		// A new process with that pid registers afresh.
		const later = Date.now();
		procs.set(7, true, later - 100);
		await writeIndex(home, [entry(A, 7, '/tmp/app', later)]);
		await waitFor(() => aya.running().length === 1);
		await aya.stop();
	});
});

test('without process watches, exits are found when the index changes or on reconcile', async () => {
	await withHome(async (home) => {
		const start = Date.now() - 1000;
		const procs = fakeProcesses(start);
		procs.set(5, true, start);
		procs.set(6, true, start);
		const unsupported: Processes = { info: procs.info, watch: () => 'unsupported' };
		await writeIndex(home, [entry(A, 5), entry(B, 6)]);
		const aya = AllYourAgents({
			providers: [grokBuild({ home })],
			processes: unsupported,
			debounce: { quietMs: 10 },
		});
		await aya.start();
		assert.equal(aya.running().length, 2);
		procs.set(5, false);
		await aya.reconcile(5);
		assert.deepEqual(
			aya.running().map((s) => s.id),
			[B],
		);
		procs.set(6, false);
		await writeIndex(home, [entry(A, 5), entry(B, 6), entry(C, 99)]);
		await waitFor(() => aya.running().length === 0);
		await aya.stop();
	});
});

test('missing home, then the index is created', async () => {
	await withHome(async (root) => {
		const home = join(root, 'not', 'yet');
		const start = Date.now() - 1000;
		const procs = fakeProcesses(start);
		procs.set(3, true, start);
		const aya = AllYourAgents({
			providers: [grokBuild({ home })],
			processes: procs,
			debounce: { quietMs: 10 },
		});
		const events = record(aya);
		await aya.start();
		assert.equal(events.length, 0);
		await writeIndex(home, [entry(A, 3)]);
		await waitFor(() => events.includes(`create:${A}`));
		await aya.stop();
	});
});

test('conversation switch closes one and opens the other without carrying state', async () => {
	await withHome(async (home) => {
		const start = Date.now() - 1000;
		const procs = fakeProcesses(start);
		procs.set(9, true, start);
		await makeSession(home, '/tmp/app', A, {
			summary: { generated_title: 'First' },
			events: [{ type: 'turn_started' }, { type: 'phase_changed', phase: 'streaming_text' }],
			chat: [user('first prompt', 0)],
		});
		await makeSession(home, '/tmp/app', B, { chat: [user('second prompt', 0)] });
		await writeIndex(home, [entry(A, 9)]);
		const aya = AllYourAgents({
			providers: [grokBuild({ home })],
			processes: procs,
			debounce: { quietMs: 10 },
		});
		const events = record(aya);
		await aya.start();
		assert.equal(aya.running()[0]?.status, 'running');
		await writeIndex(home, [entry(B, 9)]);
		await waitFor(() => events.includes(`open:${B}`));
		assert.ok(events.indexOf(`close:${A}:`) < events.indexOf(`open:${B}`));
		const b = await waitFor(() => aya.running().find((s) => s.id === B && s.title));
		assert.equal(b.title, 'second prompt');
		assert.equal(b.status, 'idle');
		await aya.stop();
	});
});

test('an index entry for a subagent session is never a root', async () => {
	await withHome(async (home) => {
		const start = Date.now() - 1000;
		const procs = fakeProcesses(start);
		procs.set(4, true, start);
		await makeSession(home, '/tmp/wt', C, { summary: { session_kind: 'subagent' } });
		await writeIndex(home, [entry(C, 4, '/tmp/wt')]);
		const aya = AllYourAgents({
			providers: [grokBuild({ home })],
			processes: procs,
			debounce: { quietMs: 10 },
		});
		const events = record(aya);
		await aya.start();
		await writeIndex(home, [entry(C, 4, '/tmp/wt')]);
		await sleep(50);
		assert.deepEqual(events, []);
		await aya.stop();
	});
});

test('a corrupt index changes nothing and the watch keeps running', async () => {
	await withHome(async (home) => {
		const start = Date.now() - 1000;
		const procs = fakeProcesses(start);
		procs.set(2, true, start);
		await writeIndex(home, [entry(A, 2)]);
		const aya = AllYourAgents({
			providers: [grokBuild({ home })],
			processes: procs,
			debounce: { quietMs: 10 },
		});
		const events = record(aya);
		await aya.start();
		await writeFile(join(home, 'active_sessions.json'), '[{"session_id":');
		await sleep(60);
		assert.equal(aya.running().length, 1);
		await writeIndex(home, []);
		await waitFor(() => events.includes(`close:${A}:`));
		await aya.stop();
	});
});

test('time passing closes nothing', async () => {
	await withHome(async (home) => {
		const start = Date.now() - 1000;
		const procs = fakeProcesses(start);
		procs.set(2, true, start);
		await writeIndex(home, [entry(A, 2)]);
		const clock = new FakeClock();
		clock.nowMs = Date.now();
		const aya = AllYourAgents({
			providers: [grokBuild({ home })],
			processes: procs,
			debounce: { quietMs: 10, clock },
		});
		const events = record(aya);
		await aya.start();
		clock.advance(24 * 3600_000);
		await sleep(20);
		assert.equal(events.filter((e) => e.startsWith('close')).length, 0);
		assert.equal(aya.running().length, 1);
		await aya.stop();
	});
});
