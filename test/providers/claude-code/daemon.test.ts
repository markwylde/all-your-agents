import assert from 'node:assert/strict';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AllYourAgents } from '../../../src/index.js';
import { claudeCode } from '../../../src/providers/claude-code/index.js';
import { sleep, waitFor } from '../../util/wait.js';
import { fakeProcesses, sessionFile } from './home.js';

const TERMINAL = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const JOB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const SPARE = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

/** A Claude home and an instance watching it, with every session event logged in order. */
async function harness(pids: number[]) {
	const home = await mkdtemp(join(tmpdir(), 'aya-cc-daemon-'));
	const start = Date.now() - 500;
	const procs = fakeProcesses(start);
	for (const pid of pids) procs.set(pid, true, start);
	const aya = AllYourAgents({
		providers: [claudeCode({ home })],
		processes: procs,
		debounce: { quietMs: 10 },
	});
	const events: string[] = [];
	aya.on('session:create', (s) => events.push(`create:${s.id}`));
	aya.on('session:open', (s) => events.push(`open:${s.id}`));
	aya.on('session:close', (s) => events.push(`close:${s.id}`));
	const running = () => aya.running().map((s) => s.id);
	const file = (pid: number, over: Record<string, unknown>) => sessionFile(home, pid, over, start);
	const done = async () => {
		await aya.stop();
		await rm(home, { recursive: true, force: true });
	};
	return { home, procs, aya, events, running, file, done };
}

test('pre-warmed spare is not a session', async () => {
	const h = await harness([1]);
	try {
		await h.file(1, { sessionId: SPARE, kind: 'bg', jobId: 'cccccccc', spare: true });
		await h.aya.start();
		await sleep(30);
		assert.deepEqual(h.events, []);
		assert.deepEqual(h.running(), []);
	} finally {
		await h.done();
	}
});

test('claimed spare binds; a bound file rewritten as a spare closes', async () => {
	const h = await harness([1]);
	try {
		await h.file(1, { sessionId: SPARE, kind: 'bg', jobId: 'cccccccc', spare: true });
		await h.aya.start();
		await h.file(1, { sessionId: JOB, kind: 'bg', jobId: 'bbbbbbbb' });
		await waitFor(() => h.events.includes(`create:${JOB}`));
		assert.deepEqual(h.running(), [JOB]);
		await h.file(1, { sessionId: SPARE, kind: 'bg', jobId: 'cccccccc', spare: true });
		await waitFor(() => h.events.includes(`close:${JOB}`));
		await sleep(30);
		assert.deepEqual(h.events, [`create:${JOB}`, `close:${JOB}`]);
		assert.deepEqual(h.running(), []);
	} finally {
		await h.done();
	}
});

test('terminal parked on a live job is hidden', async () => {
	const h = await harness([1, 2]);
	try {
		await h.file(1, { sessionId: TERMINAL, kind: 'interactive', parkedJobId: 'bbbbbbbb' });
		await h.file(2, { sessionId: JOB, kind: 'bg', jobId: 'bbbbbbbb' });
		await h.aya.start();
		await sleep(30);
		assert.deepEqual(h.running(), [JOB]);
	} finally {
		await h.done();
	}
});

test('orphaned parked id does not hide the terminal', async () => {
	const h = await harness([1]);
	try {
		await h.file(1, { sessionId: TERMINAL, kind: 'interactive', parkedJobId: 'bbbbbbbb' });
		await h.aya.start();
		assert.deepEqual(h.running(), [TERMINAL]);
	} finally {
		await h.done();
	}
});

test('job seen after the parked terminal closes it', async () => {
	const h = await harness([1, 2]);
	try {
		await h.file(1, { sessionId: TERMINAL, kind: 'interactive', parkedJobId: 'bbbbbbbb' });
		await h.aya.start();
		assert.deepEqual(h.running(), [TERMINAL]);
		await h.file(2, { sessionId: JOB, kind: 'bg', jobId: 'bbbbbbbb' });
		await waitFor(() => h.events.includes(`close:${TERMINAL}`));
		await waitFor(() => h.running().includes(JOB));
		assert.deepEqual(h.running(), [JOB]);
	} finally {
		await h.done();
	}
});

test('terminal comes back when its job exits or its file is removed', async () => {
	const h = await harness([1, 2]);
	try {
		await h.file(1, { sessionId: TERMINAL, kind: 'interactive', parkedJobId: 'bbbbbbbb' });
		await h.file(2, { sessionId: JOB, kind: 'bg', jobId: 'bbbbbbbb' });
		await h.aya.start();
		h.procs.set(2, false);
		h.procs.fire(2);
		await waitFor(() => h.running().includes(TERMINAL));
		assert.deepEqual(h.running(), [TERMINAL]);
	} finally {
		await h.done();
	}

	const h2 = await harness([1, 2]);
	try {
		await h2.file(1, { sessionId: TERMINAL, kind: 'interactive', parkedJobId: 'bbbbbbbb' });
		await h2.file(2, { sessionId: JOB, kind: 'bg', jobId: 'bbbbbbbb' });
		await h2.aya.start();
		await unlink(join(h2.home, 'sessions', '2.json'));
		await waitFor(() => h2.running().includes(TERMINAL));
		assert.deepEqual(h2.running(), [TERMINAL]);
	} finally {
		await h2.done();
	}
});

test('unparking by rewrite binds the terminal', async () => {
	const h = await harness([1, 2]);
	try {
		await h.file(1, { sessionId: TERMINAL, kind: 'interactive', parkedJobId: 'bbbbbbbb' });
		await h.file(2, { sessionId: JOB, kind: 'bg', jobId: 'bbbbbbbb' });
		await h.aya.start();
		await h.file(1, { sessionId: TERMINAL, kind: 'interactive' });
		await waitFor(() => h.running().includes(TERMINAL));
		assert.deepEqual(new Set(h.running()), new Set([TERMINAL, JOB]));
	} finally {
		await h.done();
	}
});

test('a live process with no session file is not a session', async () => {
	const h = await harness([1]);
	try {
		await h.aya.start();
		await sleep(30);
		assert.deepEqual(h.events, []);
	} finally {
		await h.done();
	}
});

test('stopping with a parked terminal re-binds nothing', async () => {
	const h = await harness([1, 2]);
	try {
		await h.file(1, { sessionId: TERMINAL, kind: 'interactive', parkedJobId: 'bbbbbbbb' });
		await h.file(2, { sessionId: JOB, kind: 'bg', jobId: 'bbbbbbbb' });
		await h.aya.start();
		await h.aya.stop();
		const before = h.events.length;
		await sleep(30);
		assert.equal(h.events.length, before);
		assert.equal(h.events.includes(`create:${TERMINAL}`), false);
	} finally {
		await h.done();
	}
});
