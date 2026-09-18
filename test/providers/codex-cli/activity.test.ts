import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AllYourAgents } from '../../../src/index.js';
import { replayRecords } from '../../../src/providers/codex-cli/activity.js';
import { codexCli } from '../../../src/providers/codex-cli/index.js';
import { waitFor } from '../../util/wait.js';
import {
	A,
	eventMsg,
	fakeCodexProcesses,
	responseItem,
	rolloutPath,
	sessionMeta,
	writeRollout,
} from './home.js';

test('forty finished turns replay as forty ended facts; unanswered call after abort is not open', () => {
	const records: unknown[] = [];
	for (let i = 0; i < 40; i++) {
		records.push(eventMsg('task_started'), eventMsg('task_complete'));
	}
	const { facts, state } = replayRecords(records);
	assert.equal(facts.filter((f) => f.type === 'turn-ended').length, 40);
	assert.equal(state.turnOpen, false);

	const aborted = replayRecords([
		eventMsg('task_started'),
		responseItem({ type: 'function_call', call_id: 'c1', name: 'exec' }),
		eventMsg('turn_aborted', { reason: 'interrupted' }),
	]);
	assert.equal(aborted.state.openTools.length, 0);
	assert.equal(
		aborted.facts.filter((f) => f.type === 'turn-ended' && f.outcome === 'interrupted').length,
		1,
	);
	const settings = replayRecords([
		eventMsg('thread_settings_applied', { thread_settings: { model: 'x' } }),
	]);
	assert.equal(settings.state.turnOpen, false);
	assert.equal(settings.facts.length, 0);
});

test('bind replays forty turns as one activity; failed error stands until next start', async () => {
	const home = await mkdtemp(join(tmpdir(), 'aya-codex-act-'));
	try {
		const start = Date.now() - 1000;
		const procs = fakeCodexProcesses(start);
		procs.set(7, true, start);
		const records: unknown[] = [sessionMeta(A)];
		for (let i = 0; i < 40; i++) records.push(eventMsg('task_started'), eventMsg('task_complete'));
		const path = rolloutPath(home, A);
		await writeRollout(path, records);
		procs.hold(7, path);
		const aya = AllYourAgents({
			providers: [codexCli({ home })],
			processes: procs,
			debounce: { quietMs: 10 },
		});
		const activity: string[] = [];
		aya.on('session:activity', (s) => activity.push(s.activity.lastTurn ?? ''));
		await aya.start();
		await waitFor(() => aya.running().some((s) => s.id === A));
		assert.equal(activity.length, 1);
		assert.equal(aya.running()[0]?.activity.lastTurn, 'completed');
		await appendFile(
			path,
			`${JSON.stringify(eventMsg('task_started'))}\n${JSON.stringify(eventMsg('task_complete', { error: { message: 'boom' } }))}\n`,
		);
		await waitFor(() => aya.running()[0]?.activity.lastTurn === 'failed');
		assert.equal(aya.running()[0]?.activity.error, 'boom');
		await appendFile(path, `${JSON.stringify(eventMsg('task_started'))}\n`);
		await waitFor(() => aya.running()[0]?.status === 'running');
		assert.equal(aya.running()[0]?.activity.error, undefined);
		await aya.stop();
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test('prompt title then index title; model switch updates', async () => {
	const home = await mkdtemp(join(tmpdir(), 'aya-codex-title-'));
	try {
		const start = Date.now() - 1000;
		const procs = fakeCodexProcesses(start);
		procs.set(6, true, start);
		const path = rolloutPath(home, A);
		await writeRollout(path, [
			sessionMeta(A),
			eventMsg('thread_settings_applied', { thread_settings: { model: 'first' } }),
			responseItem({
				type: 'message',
				role: 'user',
				content: [{ type: 'input_text', text: 'prompt title' }],
			}),
		]);
		procs.hold(6, path);
		const aya = AllYourAgents({
			providers: [codexCli({ home })],
			processes: procs,
			debounce: { quietMs: 10 },
		});
		const updates: string[] = [];
		aya.on('session:update', (s) => updates.push(s.model ?? ''));
		await aya.start();
		await waitFor(() => aya.running().some((s) => s.title === 'prompt title'));
		await writeFile(
			join(home, 'session_index.jsonl'),
			`${JSON.stringify({ id: A, thread_name: 'Harness title', updated_at: new Date().toISOString() })}\n`,
		);
		await waitFor(() => aya.running().some((s) => s.title === 'Harness title'));
		await appendFile(
			path,
			`${JSON.stringify(eventMsg('thread_settings_applied', { thread_settings: { model: 'second' } }))}\n`,
		);
		await waitFor(() => aya.running().some((s) => s.model === 'second'));
		assert.ok(updates.includes('second'));
		await aya.stop();
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
