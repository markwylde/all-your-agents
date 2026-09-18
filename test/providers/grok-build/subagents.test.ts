import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AllYourAgents } from '../../../src/index.js';
import { grokBuild } from '../../../src/providers/grok-build/index.js';
import type { Subagent } from '../../../src/types.js';
import { spyFs } from '../../util/spy-fs.js';
import { sleep, waitFor } from '../../util/wait.js';
import { entry, fakeProcesses, makeSession, user, writeIndex, writeMeta } from './home.js';

const A = '01a0b474-0a8c-7002-b1fd-ff90b332cdc3';
const S1 = '01a0b474-0a8c-7002-b1fd-ff90b332cd01';
const S2 = '01a0b474-0a8c-7002-b1fd-ff90b332cd02';
const line = (rec: unknown) => `${JSON.stringify(rec)}\n`;

const spawn = (callId: string, description: string, background = false) => ({
	type: 'assistant',
	content: '',
	model_id: 'grok-4.6-build',
	tool_calls: [
		{
			id: callId,
			name: 'spawn_subagent',
			arguments: JSON.stringify({
				description,
				prompt: 'do it',
				subagent_type: 'general-purpose',
				...(background ? { background: true } : {}),
			}),
		},
	],
});

const startedInBackground = (callId: string, id: string, description: string) => ({
	type: 'tool_result',
	tool_call_id: callId,
	content: `Subagent started in background.\nsubagent_id: ${id}\ntype: general-purpose\ndescription: ${description}\n\nWhen you need its result, use get_task_output with task_ids=["${id}"] and a positive timeout_ms.`,
});

const meta = (
	id: string,
	description: string,
	status: string,
	over: Record<string, unknown> = {},
) => ({
	subagent_id: id,
	parent_session_id: A,
	child_session_id: id,
	subagent_type: 'general-purpose',
	description,
	prompt: 'do it',
	status,
	started_at: new Date().toISOString(),
	...(status === 'running' ? {} : { completed_at: new Date().toISOString() }),
	...over,
});

type Ctx = {
	home: string;
	dir: string;
	aya: ReturnType<typeof AllYourAgents>;
	events: string[];
	starts: Subagent[];
};

async function live(
	files: Parameters<typeof makeSession>[3],
	before: (dir: string, home: string) => Promise<void>,
	fn: (ctx: Ctx) => Promise<void>,
): Promise<void> {
	const home = await mkdtemp(join(tmpdir(), 'aya-grok-'));
	try {
		const start = Date.now() - 1000;
		const procs = fakeProcesses(start);
		procs.set(8, true, start);
		const dir = await makeSession(home, '/app', A, files);
		await before(dir, home);
		await writeIndex(home, [entry(A, 8, '/app')]);
		const aya = AllYourAgents({
			providers: [grokBuild({ home })],
			processes: procs,
			debounce: { quietMs: 10 },
		});
		const events: string[] = [];
		const starts: Subagent[] = [];
		aya.on('subagent:start', (s) => {
			starts.push(s);
			events.push(`start:${s.id}:${s.parentId ?? ''}`);
		});
		aya.on('subagent:end', (s) => events.push(`end:${s.id}:${s.status}`));
		aya.on('session:create', (s) => events.push(`create:${s.id}`));
		aya.on('session:open', (s) => events.push(`open:${s.id}`));
		await aya.start();
		try {
			await fn({ home, dir, aya, events, starts });
		} finally {
			await aya.stop();
		}
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

const busy = {
	events: [{ type: 'turn_started' }, { type: 'phase_changed', phase: 'tool_execution' }],
};

test('foreground general-purpose agent: start, then completed from its meta', async () => {
	await live(
		busy,
		async () => {},
		async ({ dir, events, starts }) => {
			await appendFile(join(dir, 'chat_history.jsonl'), line(spawn('c1', 'Look around')));
			await sleep(30);
			await writeMeta(dir, meta(S1, 'Look around', 'running'));
			await waitFor(() => events.includes(`start:${S1}:`));
			assert.equal(starts[0]?.type, 'general-purpose');
			assert.equal(starts[0]?.background, false);
			assert.equal(starts[0]?.title, 'Look around');
			await writeMeta(dir, meta(S1, 'Look around', 'completed'));
			await waitFor(() => events.includes(`end:${S1}:completed`));
			assert.equal(events.filter((e) => e.startsWith('start:')).length, 1);
		},
	);
});

test('background agent outlives the turn, then completes', async () => {
	await live(
		busy,
		async () => {},
		async ({ dir, aya, events, starts }) => {
			await appendFile(
				join(dir, 'chat_history.jsonl'),
				line(spawn('c2', 'Long job', true)) + line(startedInBackground('c2', S2, 'Long job')),
			);
			await waitFor(() => events.includes(`start:${S2}:`));
			assert.equal(starts[0]?.background, true);
			await writeMeta(dir, meta(S2, 'Long job', 'running'));
			await appendFile(
				join(dir, 'events.jsonl'),
				line({ type: 'turn_ended', outcome: 'completed' }),
			);
			await waitFor(() => aya.running()[0]?.status === 'idle');
			await sleep(40);
			assert.equal(events.includes(`end:${S2}:cancelled`), false);
			await writeMeta(dir, meta(S2, 'Long job', 'completed'));
			await waitFor(() => events.includes(`end:${S2}:completed`));
		},
	);
});

test('foreground agent still open when the parent goes idle is cancelled', async () => {
	await live(
		busy,
		async () => {},
		async ({ dir, events }) => {
			await appendFile(join(dir, 'chat_history.jsonl'), line(spawn('c1', 'Look')));
			await writeMeta(dir, meta(S1, 'Look', 'running'));
			await waitFor(() => events.includes(`start:${S1}:`));
			await appendFile(
				join(dir, 'events.jsonl'),
				line({ type: 'turn_ended', outcome: 'cancelled' }),
			);
			await waitFor(() => events.includes(`end:${S1}:cancelled`));
		},
	);
});

test('meta file before the tool use: exactly one start', async () => {
	await live(
		busy,
		async () => {},
		async ({ dir, events, starts }) => {
			await writeMeta(dir, meta(S2, 'Early', 'running'));
			await waitFor(() => events.includes(`start:${S2}:`));
			await appendFile(
				join(dir, 'chat_history.jsonl'),
				line(spawn('c9', 'Early', true)) + line(startedInBackground('c9', S2, 'Early')),
			);
			await sleep(60);
			assert.equal(starts.length, 1);
		},
	);
});

test('resumed with five finished subagents: listed ended, none started', async () => {
	const ids = [1, 2, 3, 4, 5].map((n) => `01a0b474-0a8c-7002-b1fd-ff90b332ce0${n}`);
	await live(
		{ events: [] },
		async (dir) => {
			for (const id of ids)
				await writeMeta(dir, meta(id, `job ${id}`, 'completed'), { output: 'ok' });
		},
		async ({ aya, events }) => {
			const subs = (await aya.running()[0]?.subagents()) ?? [];
			assert.equal(subs.length, 5);
			assert.ok(subs.every((s) => s.status === 'completed'));
			assert.equal(events.filter((e) => e.startsWith('start:')).length, 0);
		},
	);
});

test('catch-up of a running background subagent, and its nested subagent', async () => {
	const childCwd = '/app/.grok/worktrees/child';
	await live(
		{
			events: [{ type: 'turn_started' }, { type: 'turn_ended', outcome: 'completed' }],
			chat: [
				user('go', 0),
				spawn('c2', 'Long job', true),
				startedInBackground('c2', S2, 'Long job'),
			],
		},
		async (dir) => {
			await writeMeta(dir, meta(S2, 'Long job', 'running', { child_cwd: childCwd }));
		},
		async ({ home, events, starts, aya }) => {
			assert.ok(events.includes(`start:${S2}:`), 'caught up');
			assert.equal(starts[0]?.background, true);
			const child = await makeSession(home, childCwd, S2, {
				summary: { session_kind: 'subagent' },
				chat: [user('do it', 0)],
			});
			await sleep(30);
			await appendFile(join(child, 'chat_history.jsonl'), line(spawn('n1', 'Nested')));
			await writeMeta(child, { ...meta(S1, 'Nested', 'running'), parent_session_id: S2 });
			await waitFor(() => events.includes(`start:${S1}:${S2}`));
			// The child's conversation does not touch the session's own activity.
			assert.equal(aya.running()[0]?.activity.lastTurn, 'completed');
			const sub = (await aya.running()[0]?.subagents())?.find((s) => s.id === S2);
			const turns = [];
			for await (const t of sub?.transcript() ?? []) turns.push(t);
			assert.equal(turns[0]?.events[0]?.kind, 'user');
		},
	);
});

test('a subagent registered in the live index is not a root; it starts on its parent', async () => {
	const childCwd = '/app/.grok/worktrees/child';
	await live(
		busy,
		async () => {},
		async ({ home, dir, events }) => {
			await makeSession(home, childCwd, S2, { summary: { session_kind: 'subagent' } });
			await writeMeta(dir, meta(S2, 'Child', 'running', { child_cwd: childCwd }));
			await writeIndex(home, [entry(A, 8, '/app'), entry(S2, 8, childCwd)]);
			await waitFor(() => events.includes(`start:${S2}:`));
			await sleep(40);
			assert.equal(events.includes(`open:${S2}`) || events.includes(`create:${S2}`), false);
		},
	);
});

test('meta read before the chat tail reaches its spawn still starts as background', async () => {
	const home = await mkdtemp(join(tmpdir(), 'aya-grok-'));
	try {
		const start = Date.now() - 1000;
		const procs = fakeProcesses(start);
		procs.set(8, true, start);
		const dir = await makeSession(home, '/app', A, { ...busy, chat: [user('go', 0)] });
		await writeIndex(home, [entry(A, 8, '/app')]);
		const fs = spyFs();
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let hold = false;
		const readRange = fs.readRange;
		// Appends to the conversation are tailed from a non-zero offset: hold those back.
		fs.readRange = async (path, s, e) => {
			if (hold && s > 0 && path === join(dir, 'chat_history.jsonl')) await held;
			return readRange(path, s, e);
		};
		const aya = AllYourAgents({
			providers: [grokBuild({ home })],
			processes: procs,
			fs,
			debounce: { quietMs: 10 },
		});
		const starts: Subagent[] = [];
		aya.on('subagent:start', (s) => starts.push(s));
		await aya.start();
		try {
			hold = true;
			await appendFile(
				join(dir, 'chat_history.jsonl'),
				line(spawn('c2', 'Long job', true)) + line(startedInBackground('c2', S2, 'Long job')),
			);
			await writeMeta(dir, meta(S2, 'Long job', 'running'));
			await waitFor(() => starts.length === 1);
			assert.equal(starts[0]?.background, true);
			release();
			await sleep(60);
			assert.equal(starts.length, 1);
		} finally {
			release();
			await aya.stop();
		}
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
