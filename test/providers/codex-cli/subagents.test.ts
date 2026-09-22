import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AllYourAgents } from '../../../src/index.js';
import { codexCli } from '../../../src/providers/codex-cli/index.js';
import { createCodexFixtureDriver } from '../../../src/testing/codex-driver.js';
import { waitFor } from '../../util/wait.js';
import {
	A,
	B,
	C,
	collabSpawn,
	collabWait,
	eventMsg,
	fakeCodexProcesses,
	responseItem,
	rolloutPath,
	sessionMeta,
	writeRollout,
} from './home.js';

test('child rollout starts a subagent; background flips on parent idle; one end', async () => {
	const home = await mkdtemp(join(tmpdir(), 'aya-codex-sub-'));
	const driver = createCodexFixtureDriver(home, { settleMs: 40 });
	const aya = AllYourAgents({
		providers: [codexCli({ home })],
		processes: driver.processes,
		debounce: { quietMs: 10 },
	});
	const events: string[] = [];
	aya.on('subagent:start', (s) => events.push(`start:${s.title}:${s.background}`));
	aya.on('subagent:end', (s) => events.push(`end:${s.status}`));
	try {
		await aya.start();
		const id = '00000000-0000-4000-8000-0000000000aa';
		await driver.createLiveSession({ id, pid: 8, status: 'busy' });
		const fg = await driver.launchForegroundSubagent(id);
		await waitFor(() => events.some((e) => e.startsWith('start:Sartre')));
		await driver.finishForegroundSubagent(id, fg.subagentId);
		await waitFor(() => events.includes('end:completed'));
		const bg = await driver.launchBackgroundSubagent(id);
		await waitFor(() => events.some((e) => e.startsWith('start:Hypatia')));
		await driver.rewriteStatus(id, 'idle');
		await waitFor(() => aya.running().some((row) => row.id === id));
		await driver.finishBackgroundSubagent(id, bg.subagentId);
		await waitFor(() => events.filter((e) => e === 'end:completed').length >= 2);
	} finally {
		await aya.stop();
		await rm(home, { recursive: true, force: true });
	}
});

test('spawn hint and child file either order start once; wait plus child end once', async () => {
	const home = await mkdtemp(join(tmpdir(), 'aya-codex-link-'));
	try {
		const start = Date.now() - 1000;
		const procs = fakeCodexProcesses(start);
		procs.set(8, true, start);
		const parent = rolloutPath(home, A);
		await writeRollout(parent, [sessionMeta(A), eventMsg('task_started')]);
		procs.hold(8, parent);
		const aya = AllYourAgents({
			providers: [codexCli({ home })],
			processes: procs,
			debounce: { quietMs: 10 },
		});
		const starts: string[] = [];
		const ends: string[] = [];
		aya.on('subagent:start', (s) => starts.push(s.id));
		aya.on('subagent:end', (s) => ends.push(`${s.id}:${s.status}`));
		await aya.start();
		await waitFor(() => aya.running().some((s) => s.id === A));
		await appendFile(parent, `${JSON.stringify(collabSpawn(B, 'Sartre'))}\n`);
		const child = rolloutPath(home, B);
		await writeRollout(child, [
			sessionMeta(B, {
				parent_thread_id: A,
				thread_source: 'subagent',
				source: { subagent: {} },
				agent_nickname: 'Sartre',
			}),
			eventMsg('task_started'),
		]);
		procs.hold(8, child);
		await waitFor(() => starts.includes(B));
		assert.equal(starts.filter((id) => id === B).length, 1);
		await appendFile(child, `${JSON.stringify(eventMsg('task_complete'))}\n`);
		await appendFile(parent, `${JSON.stringify(collabWait(B))}\n`);
		await waitFor(() => ends.includes(`${B}:completed`));
		assert.equal(ends.filter((e) => e.startsWith(`${B}:`)).length, 1);
		await aya.stop();
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test('nested parentId; child transcript does not change root activity', async () => {
	const home = await mkdtemp(join(tmpdir(), 'aya-codex-nest-'));
	try {
		const start = Date.now() - 1000;
		const procs = fakeCodexProcesses(start);
		procs.set(3, true, start);
		const parent = rolloutPath(home, A);
		await writeRollout(parent, [sessionMeta(A), eventMsg('task_started')]);
		procs.hold(3, parent);
		const aya = AllYourAgents({
			providers: [codexCli({ home })],
			processes: procs,
			debounce: { quietMs: 10 },
		});
		await aya.start();
		await waitFor(() => aya.running().some((s) => s.id === A));
		await writeRollout(rolloutPath(home, B), [
			sessionMeta(B, {
				parent_thread_id: A,
				thread_source: 'subagent',
				source: { subagent: {} },
				agent_nickname: 'Sartre',
			}),
			eventMsg('task_started'),
		]);
		procs.hold(3, rolloutPath(home, B));
		await writeRollout(rolloutPath(home, C), [
			sessionMeta(C, {
				parent_thread_id: B,
				thread_source: 'subagent',
				source: { subagent: {} },
				agent_nickname: 'Euler',
			}),
			eventMsg('task_started'),
		]);
		procs.hold(3, rolloutPath(home, C));
		const deadline = Date.now() + 2000;
		let nested = false;
		while (Date.now() < deadline) {
			const subs = await aya
				.running()
				.find((s) => s.id === A)
				?.subagents();
			if (subs?.some((s) => s.id === C && s.parentId === B)) {
				nested = true;
				break;
			}
			await new Promise((r) => setTimeout(r, 15));
		}
		assert.ok(nested);
		const root = aya.running().find((s) => s.id === A);
		assert.ok(root);
		const before = root.activity.lastTurn;
		await appendFile(
			rolloutPath(home, C),
			`${JSON.stringify(responseItem({ type: 'function_call', call_id: 'x', name: 'exec' }))}\n`,
		);
		await new Promise((r) => setTimeout(r, 80));
		assert.equal(root.activity.lastTurn, before);
		assert.equal(root.activity.tool, undefined);
		await aya.stop();
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test('bindHeld: child before parent is seeded completed, not started live', async () => {
	const home = await mkdtemp(join(tmpdir(), 'aya-codex-seed-'));
	try {
		const start = Date.now() - 1000;
		const procs = fakeCodexProcesses(start);
		procs.set(8, true, start);
		const child = rolloutPath(home, B);
		await writeRollout(child, [
			sessionMeta(B, {
				parent_thread_id: A,
				thread_source: 'subagent',
				source: { subagent: {} },
				agent_nickname: 'Gauss',
			}),
			eventMsg('task_started'),
			eventMsg('task_complete'),
		]);
		procs.hold(8, child);
		const parent = rolloutPath(home, A);
		await writeRollout(parent, [sessionMeta(A), eventMsg('task_complete')]);
		procs.hold(8, parent);
		const aya = AllYourAgents({
			providers: [codexCli({ home })],
			processes: procs,
			debounce: { quietMs: 10 },
		});
		const starts: string[] = [];
		aya.on('subagent:start', (s) => starts.push(s.id));
		await aya.start();
		await waitFor(() => aya.running().some((s) => s.id === A));
		assert.deepEqual(starts, []);
		const subs = await aya.running()[0]?.subagents();
		assert.equal(subs?.find((s) => s.id === B)?.status, 'completed');
		assert.equal(subs?.find((s) => s.id === B)?.title, 'Gauss');
		await aya.stop();
		const hist = AllYourAgents({ providers: [codexCli({ home })] });
		const listed = await hist.get(A);
		const history = await listed?.subagents();
		assert.equal(history?.find((s) => s.id === B)?.status, 'completed');
		await hist.stop();
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test('child file before parent binds is linked once the parent appears', async () => {
	const home = await mkdtemp(join(tmpdir(), 'aya-codex-late-'));
	try {
		const start = Date.now() - 1000;
		const procs = fakeCodexProcesses(start);
		procs.set(8, true, start);
		const aya = AllYourAgents({
			providers: [codexCli({ home })],
			processes: procs,
			debounce: { quietMs: 10 },
		});
		const starts: string[] = [];
		aya.on('subagent:start', (s) => starts.push(s.id));
		await aya.start();
		const child = rolloutPath(home, B);
		await writeRollout(child, [
			sessionMeta(B, {
				parent_thread_id: A,
				thread_source: 'subagent',
				source: { subagent: {} },
				agent_nickname: 'Jason',
			}),
			eventMsg('task_started'),
		]);
		procs.hold(8, child);
		const parent = rolloutPath(home, A);
		await writeRollout(parent, [sessionMeta(A), eventMsg('task_started')]);
		procs.hold(8, parent);
		await waitFor(() => aya.running().some((s) => s.id === A));
		const deadline = Date.now() + 2000;
		let title: string | undefined;
		while (Date.now() < deadline) {
			const subs = await aya
				.running()
				.find((s) => s.id === A)
				?.subagents();
			title = subs?.find((s) => s.id === B)?.title;
			if (title === 'Jason') break;
			await new Promise((r) => setTimeout(r, 15));
		}
		assert.equal(title, 'Jason');
		assert.deepEqual(starts, [B]);
		await aya.stop();
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
