import assert from 'node:assert/strict';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AllYourAgents } from '../../../src/index.js';
import { claudeCode } from '../../../src/providers/claude-code/index.js';
import { sleep, waitFor } from '../../util/wait.js';
import { fakeProcesses, sessionFile } from './home.js';

const ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

/** A Claude home where pid 1 started first and pid 2 a second later, both naming `ID`. */
async function harness() {
	const home = await mkdtemp(join(tmpdir(), 'aya-cc-shared-'));
	const start = Date.now() - 2000;
	const startOf = (pid: number) => start + (pid - 1) * 1000;
	const procs = fakeProcesses(start);
	for (const pid of [1, 2]) procs.set(pid, true, startOf(pid));
	const aya = AllYourAgents({
		providers: [claudeCode({ home })],
		processes: procs,
		debounce: { quietMs: 10 },
	});
	const events: string[] = [];
	aya.on('session:create', (s) => events.push(`create:${s.pid}`));
	aya.on('session:open', (s) => events.push(`open:${s.pid}`));
	aya.on('session:close', () => events.push('close'));
	const pids = () => aya.running().map((s) => s.pid);
	const file = (pid: number, over: Record<string, unknown> = {}) =>
		sessionFile(home, pid, { sessionId: ID, startedAt: startOf(pid), ...over }, start);
	const done = async () => {
		await aya.stop();
		await rm(home, { recursive: true, force: true });
	};
	return { home, procs, aya, events, pids, file, done };
}

test('a session resumed in a second process moves to it', async () => {
	const h = await harness();
	try {
		await h.file(1);
		await h.aya.start();
		assert.deepEqual(h.pids(), [1]);
		await h.file(2, { status: 'busy' });
		await waitFor(() => h.pids().includes(2));
		assert.deepEqual(h.events, ['create:1', 'close', 'create:2']);
		assert.equal(h.aya.running()[0]?.status, 'running');
	} finally {
		await h.done();
	}
});

test('the first process exiting leaves the resumed session live', async () => {
	const h = await harness();
	try {
		await h.file(1);
		await h.aya.start();
		await h.file(2);
		await waitFor(() => h.pids().includes(2));
		h.procs.set(1, false);
		h.procs.fire(1);
		await unlink(join(h.home, 'sessions', '1.json'));
		await sleep(60);
		assert.deepEqual(h.pids(), [2]);
		assert.deepEqual(h.events, ['create:1', 'close', 'create:2']);
		await h.file(2, { status: 'busy' });
		await waitFor(() => h.aya.running()[0]?.status === 'running');
	} finally {
		await h.done();
	}
});

test('the first process takes the session back when the second exits', async () => {
	const h = await harness();
	try {
		await h.file(1);
		await h.aya.start();
		await h.file(2);
		await waitFor(() => h.pids().includes(2));
		h.procs.set(2, false);
		h.procs.fire(2);
		await waitFor(() => h.pids().includes(1));
		assert.deepEqual(h.events, ['create:1', 'close', 'create:2', 'close', 'create:1']);
	} finally {
		await h.done();
	}
});

test('both processes present at start: the later one holds the session', async () => {
	const h = await harness();
	try {
		await h.file(1);
		await h.file(2);
		await h.aya.start();
		await sleep(60);
		assert.deepEqual(h.pids(), [2]);
	} finally {
		await h.done();
	}
});

test('a waiting process rewriting its file does not take the session back', async () => {
	const h = await harness();
	try {
		await h.file(1);
		await h.aya.start();
		await h.file(2);
		await waitFor(() => h.pids().includes(2));
		await h.file(1, { status: 'busy' });
		await sleep(60);
		assert.deepEqual(h.pids(), [2]);
		assert.equal(h.aya.running()[0]?.status, 'idle');
		assert.deepEqual(h.events, ['create:1', 'close', 'create:2']);
	} finally {
		await h.done();
	}
});

test('start times that cannot tell the processes apart: the newcomer holds, and keeps it', async () => {
	const h = await harness();
	try {
		const same = { startedAt: undefined };
		await h.file(1, same);
		await h.aya.start();
		await h.file(2, same);
		await waitFor(() => h.pids().includes(2));
		await h.file(1, { ...same, status: 'busy' });
		await sleep(60);
		assert.deepEqual(h.pids(), [2]);
	} finally {
		await h.done();
	}
});

test('a waiting file that is removed is not serviced when the holder exits', async () => {
	const h = await harness();
	try {
		await h.file(1);
		await h.aya.start();
		await h.file(2);
		await waitFor(() => h.pids().includes(2));
		await unlink(join(h.home, 'sessions', '1.json'));
		await sleep(60);
		h.procs.set(2, false);
		h.procs.fire(2);
		await waitFor(() => h.pids().length === 0);
		await sleep(60);
		assert.deepEqual(h.pids(), []);
		assert.deepEqual(h.events, ['create:1', 'close', 'create:2', 'close']);
	} finally {
		await h.done();
	}
});
