import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { AllYourAgents } from '../../../src/index.js';
import { grokBuild } from '../../../src/providers/grok-build/index.js';
import { spyFs } from '../../util/spy-fs.js';
import { sleep, waitFor } from '../../util/wait.js';
import { entry, fakeProcesses, makeSession, sessionDir, writeIndex, writeMeta } from './home.js';

const A = '01a0b474-0a8c-7002-b1fd-ff90b332cdc3';
const SUB = '01a0b474-0a8c-7002-b1fd-ff90b332cd01';

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
	const home = await mkdtemp(join(tmpdir(), 'aya-grok-'));
	try {
		await fn(home);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

const line = (rec: unknown) => `${JSON.stringify(rec)}\n`;

test('worktree move: update only, new path tailed, finished subagents stay finished', async () => {
	await withHome(async (home) => {
		const start = Date.now() - 1000;
		const procs = fakeProcesses(start);
		procs.set(8, true, start);
		const dir = await makeSession(home, '/app', A, {
			events: [{ type: 'turn_started' }, { type: 'turn_ended', outcome: 'completed' }],
		});
		await writeMeta(dir, {
			subagent_id: SUB,
			parent_session_id: A,
			child_session_id: SUB,
			subagent_type: 'general-purpose',
			description: 'Look',
			status: 'completed',
			completed_at: new Date().toISOString(),
		});
		await writeIndex(home, [entry(A, 8, '/app')]);
		const aya = AllYourAgents({
			providers: [grokBuild({ home })],
			processes: procs,
			debounce: { quietMs: 10 },
		});
		const events: string[] = [];
		aya.on('session:update', (s) => events.push(`update:${s.cwd}`));
		aya.on('session:close', () => events.push('close'));
		aya.on('subagent:start', (s) => events.push(`start:${s.id}`));
		await aya.start();
		const session = aya.running()[0];
		assert.equal((await session?.subagents())?.[0]?.status, 'completed');
		const moved = sessionDir(home, '/app/.grok/worktrees/x', A);
		await mkdir(dirname(moved), { recursive: true });
		await rename(dir, moved);
		await writeIndex(home, [entry(A, 8, '/app/.grok/worktrees/x')]);
		await waitFor(() => events.includes('update:/app/.grok/worktrees/x'));
		await sleep(50);
		await appendFile(join(moved, 'events.jsonl'), line({ type: 'turn_started' }));
		await waitFor(() => aya.running()[0]?.status === 'running');
		assert.equal(events.includes('close'), false);
		assert.equal(events.filter((e) => e.startsWith('start:')).length, 0);
		await aya.stop();
	});
});

test('index moves first: the old tails continue until the directory follows', async () => {
	await withHome(async (home) => {
		const start = Date.now() - 1000;
		const procs = fakeProcesses(start);
		procs.set(8, true, start);
		const dir = await makeSession(home, '/app', A, { events: [] });
		await writeIndex(home, [entry(A, 8, '/app')]);
		const aya = AllYourAgents({
			providers: [grokBuild({ home })],
			processes: procs,
			debounce: { quietMs: 10 },
		});
		await aya.start();
		await writeIndex(home, [entry(A, 8, '/elsewhere')]);
		await waitFor(() => aya.running()[0]?.cwd === '/elsewhere');
		await appendFile(join(dir, 'events.jsonl'), line({ type: 'turn_started' }));
		await waitFor(() => aya.running()[0]?.status === 'running');
		const moved = sessionDir(home, '/elsewhere', A);
		await mkdir(dirname(moved), { recursive: true });
		await rename(dir, moved);
		await sleep(80);
		await appendFile(
			join(moved, 'events.jsonl'),
			line({ type: 'turn_ended', outcome: 'completed' }),
		);
		await waitFor(() => aya.running()[0]?.status === 'idle');
		await aya.stop();
	});
});

test('entry removed while binding: open then close, only the index watched', async () => {
	await withHome(async (home) => {
		const start = Date.now() - 1000;
		const procs = fakeProcesses(start);
		procs.set(8, true, start);
		const dir = await makeSession(home, '/app', A, { events: [{ type: 'turn_started' }] });
		const fs = spyFs();
		const aya = AllYourAgents({
			providers: [grokBuild({ home })],
			processes: procs,
			fs,
			debounce: { quietMs: 10 },
		});
		const events: string[] = [];
		aya.on('session:open', () => events.push('open'));
		aya.on('session:close', () => events.push('close'));
		await aya.start();
		let once = false;
		fs.hooks.stat = async (path) => {
			if (once || path !== dir) return;
			once = true;
			await writeIndex(home, []);
			await sleep(40);
		};
		await writeIndex(home, [entry(A, 8, '/app')]);
		await waitFor(() => events.includes('close'));
		assert.deepEqual(events, ['open', 'close']);
		assert.equal(aya.running().length, 0);
		await sleep(40);
		assert.deepEqual(fs.openWatches(), [home]);
		await aya.stop();
	});
});

test('process exits while the events backlog is read: closed, and nothing left watched', async () => {
	await withHome(async (home) => {
		const start = Date.now() - 1000;
		const procs = fakeProcesses(start);
		procs.set(8, true, start);
		const dir = await makeSession(home, '/app', A, { events: [{ type: 'turn_started' }] });
		const fs = spyFs();
		const readRange = fs.readRange;
		fs.readRange = async (path, s, e) => {
			const bytes = await readRange(path, s, e);
			if (path === join(dir, 'events.jsonl')) procs.fire(8);
			return bytes;
		};
		await writeIndex(home, [entry(A, 8, '/app')]);
		const aya = AllYourAgents({
			providers: [grokBuild({ home })],
			processes: procs,
			fs,
			debounce: { quietMs: 10 },
		});
		const events: string[] = [];
		aya.on('session:close', () => events.push('close'));
		await aya.start();
		await waitFor(() => events.includes('close'));
		await sleep(40);
		assert.deepEqual(fs.openWatches(), [home]);
		await aya.stop();
		assert.deepEqual(fs.openWatches(), []);
	});
});

test('stopped while binding: no event and no watch', async () => {
	await withHome(async (home) => {
		const start = Date.now() - 1000;
		const procs = fakeProcesses(start);
		procs.set(8, true, start);
		const dir = await makeSession(home, '/app', A, { events: [{ type: 'turn_started' }] });
		const fs = spyFs();
		const aya = AllYourAgents({
			providers: [grokBuild({ home })],
			processes: procs,
			fs,
			debounce: { quietMs: 10 },
		});
		const events: string[] = [];
		aya.on('session:open', () => events.push('open'));
		aya.on('session:create', () => events.push('create'));
		await aya.start();
		let stopped: Promise<void> | undefined;
		fs.hooks.stat = async (path) => {
			if (stopped || path !== dir) return;
			stopped = aya.stop();
			await stopped;
		};
		await writeIndex(home, [entry(A, 8, '/app')]);
		await waitFor(() => stopped);
		await stopped;
		await sleep(40);
		assert.deepEqual(events, []);
		assert.deepEqual(fs.openWatches(), []);
	});
});
