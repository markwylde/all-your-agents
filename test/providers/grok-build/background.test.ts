import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AllYourAgents } from '../../../src/index.js';
import { grokBuild } from '../../../src/providers/grok-build/index.js';
import { type SpyFs, spyFs } from '../../util/spy-fs.js';
import { sleep, waitFor } from '../../util/wait.js';
import {
	chunkRow,
	entry,
	fakeProcesses,
	makeSession,
	taskCompletedRow,
	tasksRow,
	updateRow,
	writeIndex,
} from './home.js';

const A = '01a0b474-0a8c-7002-b1fd-ff90b332cdc3';
const line = (rec: unknown) => `${JSON.stringify(rec)}\n`;
const over = [{ type: 'turn_started' }, { type: 'turn_ended', outcome: 'completed' }];

type Ctx = {
	home: string;
	dir: string;
	aya: ReturnType<typeof AllYourAgents>;
	fs: SpyFs;
	/** `session:status` as `status` or `status:waitingFor`, in order. */
	statuses: string[];
	errors: string[];
	appendEvents(...records: unknown[]): Promise<void>;
	appendUpdates(...records: unknown[]): Promise<void>;
};

async function live(
	files: Parameters<typeof makeSession>[3],
	fn: (ctx: Ctx) => Promise<void>,
): Promise<void> {
	const home = await mkdtemp(join(tmpdir(), 'aya-grok-'));
	try {
		const start = Date.now() - 1000;
		const procs = fakeProcesses(start);
		procs.set(8, true, start);
		const dir = await makeSession(home, '/app', A, files);
		await writeIndex(home, [entry(A, 8, '/app')]);
		const fs = spyFs();
		const aya = AllYourAgents({
			providers: [grokBuild({ home })],
			processes: procs,
			fs,
			debounce: { quietMs: 10 },
		});
		const statuses: string[] = [];
		const errors: string[] = [];
		aya.on('session:status', (s) =>
			statuses.push(s.waitingFor ? `${s.status}:${s.waitingFor}` : String(s.status)),
		);
		aya.on('error', (e) => errors.push(String(e.error)));
		await aya.start();
		try {
			await fn({
				home,
				dir,
				aya,
				fs,
				statuses,
				errors,
				appendEvents: (...records) =>
					appendFile(join(dir, 'events.jsonl'), records.map(line).join('')),
				appendUpdates: (...records) =>
					appendFile(join(dir, 'updates.jsonl'), records.map(line).join('')),
			});
		} finally {
			await aya.stop();
		}
		assert.deepEqual(fs.openWatches(), []);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

test('bound while a monitor is running: waiting for it, and never idle first', async () => {
	await live(
		{
			events: over,
			updates: [
				chunkRow('agent_message_chunk'),
				tasksRow(['t0', 'bash', 'running']),
				taskCompletedRow('t0'),
				tasksRow(['t0', 'bash', 'completed'], ['t1', 'monitor', 'running']),
				updateRow({ sessionUpdate: 'turn_completed' }),
			],
		},
		async ({ aya, statuses, errors }) => {
			assert.deepEqual(statuses, ['waiting:monitor']);
			const session = aya.running()[0];
			assert.equal(session?.status, 'waiting');
			assert.equal(session?.waitingFor, 'monitor');
			assert.equal(session?.activity.lastTurn, 'completed');
			await sleep(60);
			assert.deepEqual(statuses, ['waiting:monitor']);
			assert.deepEqual(errors, []);
		},
	);
});

test('bound inside an open turn with a task running: running', async () => {
	await live(
		{
			events: [{ type: 'turn_started' }, { type: 'phase_changed', phase: 'streaming_text' }],
			updates: [tasksRow(['t1', 'monitor', 'running'])],
		},
		async ({ statuses }) => {
			assert.deepEqual(statuses, ['running']);
		},
	);
});

test('no updates.jsonl: status follows events.jsonl alone, without an error', async () => {
	await live({ events: over }, async ({ aya, statuses, errors, appendEvents }) => {
		assert.deepEqual(statuses, ['idle']);
		await appendEvents({ type: 'turn_started' });
		await waitFor(() => aya.running()[0]?.status === 'running');
		await appendEvents({ type: 'turn_ended', outcome: 'completed' });
		await waitFor(() => aya.running()[0]?.status === 'idle');
		assert.deepEqual(statuses, ['idle', 'running', 'idle']);
		assert.deepEqual(errors, []);
	});
});

test('updates.jsonl appearing after bind is picked up', async () => {
	await live({ events: over }, async ({ aya, statuses, appendUpdates }) => {
		assert.deepEqual(statuses, ['idle']);
		await sleep(40);
		await appendUpdates(chunkRow('agent_message_chunk'), tasksRow(['t1', 'bash', 'running']));
		await waitFor(() => aya.running()[0]?.status === 'waiting');
		assert.equal(aya.running()[0]?.waitingFor, 'shell');
		assert.deepEqual(statuses, ['idle', 'waiting:shell']);
	});
});

test('the updates watch is held while bound and released when the session closes', async () => {
	await live({ events: over, updates: [] }, async ({ home, dir, aya, fs }) => {
		const path = join(dir, 'updates.jsonl');
		assert.ok(fs.openWatches().includes(path), 'updates.jsonl is watched');
		const closed: string[] = [];
		aya.on('session:close', (s) => closed.push(s.id));
		await writeIndex(home, []);
		await waitFor(() => closed.length === 1);
		await sleep(40);
		assert.deepEqual(fs.openWatches(), [home]);
	});
});

test('a monitor outlives the turn, then wakes the session', async () => {
	await live(
		{ events: [{ type: 'turn_started' }], updates: [] },
		async ({ aya, statuses, appendEvents, appendUpdates }) => {
			assert.deepEqual(statuses, ['running']);
			await appendUpdates(
				updateRow({ sessionUpdate: 'task_backgrounded', task_id: 't1' }),
				tasksRow(['t1', 'monitor', 'running']),
			);
			await sleep(40);
			assert.deepEqual(statuses, ['running'], 'an open turn takes its status from the phase');
			await appendEvents({ type: 'turn_ended', outcome: 'completed' });
			await waitFor(() => aya.running()[0]?.status === 'waiting');
			assert.equal(aya.running()[0]?.waitingFor, 'monitor');
			assert.equal(aya.running()[0]?.activity.lastTurn, 'completed');
			await appendEvents({ type: 'turn_started' });
			await waitFor(() => aya.running()[0]?.status === 'running');
			assert.equal(aya.running()[0]?.waitingFor, undefined);
			assert.deepEqual(statuses, ['running', 'waiting:monitor', 'running']);
		},
	);
});

test('snapshot and turn end written together: waiting, never idle', async () => {
	await live(
		{ events: [{ type: 'turn_started' }], updates: [] },
		async ({ aya, statuses, appendEvents, appendUpdates }) => {
			await Promise.all([
				appendEvents({ type: 'turn_ended', outcome: 'completed' }),
				appendUpdates(tasksRow(['t1', 'bash', 'running'])),
			]);
			await waitFor(() => aya.running()[0]?.status === 'waiting');
			await sleep(40);
			assert.deepEqual(statuses, ['running', 'waiting:shell']);
		},
	);
});

test('the last task reported failed by a snapshot, with no turn open: idle', async () => {
	await live(
		{ events: over, updates: [tasksRow(['t1', 'bash', 'running'])] },
		async ({ aya, statuses, appendUpdates }) => {
			assert.deepEqual(statuses, ['waiting:shell']);
			await appendUpdates(tasksRow(['t1', 'bash', 'failed']));
			await waitFor(() => aya.running()[0]?.status === 'idle');
			assert.equal(aya.running()[0]?.waitingFor, undefined);
			assert.deepEqual(statuses, ['waiting:shell', 'idle']);
		},
	);
});

test('the last task reported by task_completed, with no turn open: idle', async () => {
	await live(
		{ events: over, updates: [tasksRow(['t1', 'monitor', 'running'])] },
		async ({ aya, statuses, appendUpdates }) => {
			assert.deepEqual(statuses, ['waiting:monitor']);
			await appendUpdates(taskCompletedRow('t1', 1));
			await waitFor(() => aya.running()[0]?.status === 'idle');
			assert.deepEqual(statuses, ['waiting:monitor', 'idle']);
		},
	);
});

test('a later snapshot replaces an earlier one', async () => {
	await live(
		{
			events: over,
			updates: [tasksRow(['t1', 'bash', 'running'], ['t2', 'monitor', 'running'])],
		},
		async ({ aya, statuses, appendUpdates }) => {
			assert.deepEqual(statuses, ['waiting:monitor']);
			await appendUpdates(tasksRow(['t1', 'bash', 'running'], ['t2', 'monitor', 'completed']));
			await waitFor(() => aya.running()[0]?.waitingFor === 'shell');
			// A task the new snapshot no longer lists is gone, not still running.
			await appendUpdates(tasksRow(['t3', 'bash', 'completed']));
			await waitFor(() => aya.running()[0]?.status === 'idle');
			assert.deepEqual(statuses, ['waiting:monitor', 'waiting:shell', 'idle']);
		},
	);
});

test('a malformed task row is reported and the known tasks are kept', async () => {
	await live(
		{ events: over, updates: [tasksRow(['t1', 'monitor', 'running'])] },
		async ({ aya, statuses, errors, appendUpdates }) => {
			await appendUpdates(
				chunkRow('tool_call_update'),
				updateRow({ sessionUpdate: 'background_tasks' }),
			);
			await waitFor(() => errors.length === 1);
			assert.match(errors[0] ?? '', /background_tasks/);
			assert.equal(aya.running()[0]?.waitingFor, 'monitor');
			assert.deepEqual(statuses, ['waiting:monitor']);
		},
	);
});
