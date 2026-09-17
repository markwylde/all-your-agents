import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Processes } from '../../../src/helpers/types.js';
import { AllYourAgents } from '../../../src/index.js';
import { claudeCode } from '../../../src/providers/claude-code/index.js';
import { encodeProjectDir } from '../../../src/providers/claude-code/paths.js';
import type { Session } from '../../../src/types.js';
import { sleep, waitFor } from '../../util/wait.js';
import { fakeProcesses, journal, sessionFile } from './home.js';

const ID_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

test('two sessions in one cwd bind separately; key sibling never read', async () => {
	const home = await mkdtemp(join(tmpdir(), 'aya-cc-'));
	const start = Date.now() - 500;
	const procs = fakeProcesses(start);
	procs.set(1, true, start);
	procs.set(2, true, start);
	const reads: string[] = [];
	const { createLocalFs } = await import('../../../src/helpers/fs.js');
	const inner = createLocalFs();
	const fs = {
		...inner,
		async readFile(path: string, opts?: { maxBytes?: number }) {
			reads.push(path);
			return inner.readFile(path, opts);
		},
	};
	try {
		await sessionFile(home, 1, { sessionId: ID_A, cwd: '/tmp/app' }, start);
		await sessionFile(home, 2, { sessionId: ID_B, cwd: '/tmp/app' }, start);
		await writeFile(join(home, 'sessions', '1.deadbeef.key'), 'secret');
		const aya = AllYourAgents({
			providers: [claudeCode({ home })],
			processes: procs,
			fs,
			debounce: { quietMs: 10 },
		});
		const ids: string[] = [];
		aya.on('session:create', (s) => ids.push(s.id));
		aya.on('session:open', (s) => ids.push(`open:${s.id}`));
		await aya.start();
		assert.deepEqual(new Set(ids), new Set([ID_A, ID_B]));
		assert.equal(
			reads.some((p) => p.endsWith('.key')),
			false,
		);
		await aya.stop();
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test('open vs create; status and cwd in one write; switch; unlink', async () => {
	const home = await mkdtemp(join(tmpdir(), 'aya-cc-'));
	const start = Date.now() - 500;
	const procs = fakeProcesses(start);
	procs.set(9, true, start);
	try {
		await journal(home, '/tmp/app', ID_A, [
			{ type: 'user', sessionId: ID_A, message: { content: 'hi' } },
		]);
		await sessionFile(home, 9, { sessionId: ID_A, cwd: '/tmp/app', status: 'busy' }, start);
		const aya = AllYourAgents({
			providers: [claudeCode({ home })],
			processes: procs,
			debounce: { quietMs: 10 },
		});
		const events: string[] = [];
		aya.on('session:create', (s) => events.push(`create:${s.id}`));
		aya.on('session:open', (s) => events.push(`open:${s.id}`));
		aya.on('session:status', (s) => events.push(`status:${s.status}`));
		aya.on('session:update', (s) => events.push(`update:${s.cwd}`));
		aya.on('session:close', (s) => events.push(`close:${s.id}:${s.pid ?? ''}`));
		await aya.start();
		assert.ok(events.includes(`open:${ID_A}`));
		await sessionFile(home, 9, { sessionId: ID_A, cwd: '/tmp/other', status: 'idle' }, start);
		await waitFor(
			() => events.includes('status:idle') && events.some((e) => e.startsWith('update:')),
		);
		events.length = 0;
		await sessionFile(home, 9, { sessionId: ID_B, cwd: '/tmp/app', status: 'busy' }, start);
		await waitFor(() => events.includes(`close:${ID_A}:`) && events.includes(`create:${ID_B}`));
		await unlink(join(home, 'sessions', '9.json'));
		await waitFor(() => events.some((e) => e.startsWith(`close:${ID_B}`)));
		await aya.stop();
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test('kill -9 via exit event and via reconcile; stale rewrite; clock does not close', async () => {
	const home = await mkdtemp(join(tmpdir(), 'aya-cc-'));
	const start = Date.now() - 500;
	const procs = fakeProcesses(start);
	procs.set(4, true, start);
	try {
		await sessionFile(home, 4, { sessionId: ID_A, cwd: '/tmp/app' }, start);
		const aya = AllYourAgents({
			providers: [claudeCode({ home })],
			processes: procs,
			debounce: { quietMs: 10 },
		});
		const closes: string[] = [];
		aya.on('session:close', (s) => closes.push(s.id));
		aya.on('session:create', (s: Session) => closes.push(`create:${s.id}`));
		await aya.start();
		procs.set(4, false);
		procs.fire(4);
		await waitFor(() => closes.includes(ID_A));
		assert.equal(aya.running().length, 0);
		const later = Date.now();
		procs.set(4, true, later);
		await sessionFile(home, 4, { sessionId: ID_B, cwd: '/tmp/app', startedAt: later }, later);
		await waitFor(() => closes.includes(`create:${ID_B}`));
		await aya.stop();
	} finally {
		await rm(home, { recursive: true, force: true });
	}

	const home2 = await mkdtemp(join(tmpdir(), 'aya-cc-'));
	const procs2 = fakeProcesses(start);
	procs2.set(5, true, start);
	const unsupported: Processes = {
		info: (pid) => procs2.info(pid),
		watch: () => 'unsupported',
	};
	try {
		await sessionFile(home2, 5, { sessionId: ID_A, cwd: '/tmp/app' }, start);
		const aya = AllYourAgents({
			providers: [claudeCode({ home: home2 })],
			processes: unsupported,
			debounce: { quietMs: 10 },
		});
		const closes: string[] = [];
		aya.on('session:close', (s) => closes.push(s.id));
		await aya.start();
		procs2.set(5, false);
		await aya.reconcile(5);
		await waitFor(() => closes.includes(ID_A));
		await sleep(30);
		assert.deepEqual(closes, [ID_A]);
		await aya.stop();
	} finally {
		await rm(home2, { recursive: true, force: true });
	}
	void rename;
});

test('print-mode journal is headless history only', async () => {
	const home = await mkdtemp(join(tmpdir(), 'aya-cc-'));
	try {
		await journal(home, '/tmp/app', ID_A, [
			{
				type: 'user',
				sessionId: ID_A,
				entrypoint: 'sdk-cli',
				timestamp: '2026-09-16T00:00:00.000Z',
				message: { content: 'print' },
			},
		]);
		const aya = AllYourAgents({
			providers: [claudeCode({ home })],
			processes: fakeProcesses(),
		});
		const live: string[] = [];
		aya.on('session:create', (s) => live.push(s.id));
		await aya.start();
		assert.deepEqual(live, []);
		const listed = await aya.sessions({ kind: 'headless', since: 0 });
		assert.equal(listed[0]?.id, ID_A);
		assert.equal(listed[0]?.kind, 'headless');
		await aya.stop();
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test('a reply split into records plus turn_duration and idle ends the turn once', async () => {
	const home = await mkdtemp(join(tmpdir(), 'aya-cc-'));
	const start = Date.now() - 500;
	const procs = fakeProcesses(start);
	procs.set(7, true, start);
	const cwd = '/tmp/app';
	const path = join(home, 'projects', encodeProjectDir(cwd), `${ID_A}.jsonl`);
	const at = (ms: number) => new Date(Date.now() + ms).toISOString();
	const append = (records: unknown[]) =>
		appendFile(path, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
	let aya: ReturnType<typeof AllYourAgents> | undefined;
	try {
		await journal(home, cwd, ID_A, [
			{ type: 'user', sessionId: ID_A, timestamp: at(-400), message: { content: 'hi' } },
			{
				type: 'assistant',
				sessionId: ID_A,
				timestamp: at(-300),
				message: { id: 'm0', stop_reason: 'end_turn', content: [{ type: 'text', text: 'hello' }] },
			},
			{ type: 'system', subtype: 'turn_duration', sessionId: ID_A, timestamp: at(-200) },
		]);
		await sessionFile(home, 7, { sessionId: ID_A, cwd, status: 'idle' }, start);
		aya = AllYourAgents({
			providers: [claudeCode({ home })],
			processes: procs,
			debounce: { quietMs: 5, maxLatencyMs: 50 },
		});
		const running = aya;
		const ends: string[] = [];
		const tools: string[] = [];
		aya.on('session:activity', (s, meta) => {
			if (meta.catchUp) return;
			if (s.activity.tool) tools.push(s.activity.tool.name);
			else if (s.activity.lastTurn)
				ends.push(`${s.activity.lastTurn}@${s.activity.lastTurnEndedAt}`);
		});
		await aya.start();

		await sessionFile(home, 7, { sessionId: ID_A, cwd, status: 'busy' }, start);
		await append([
			{ type: 'user', sessionId: ID_A, timestamp: at(0), message: { content: 'search' } },
			{
				type: 'assistant',
				sessionId: ID_A,
				timestamp: at(10),
				message: {
					id: 'm1',
					stop_reason: 'tool_use',
					content: [{ type: 'tool_use', id: 'toolu_1', name: 'WebSearch', input: {} }],
				},
			},
		]);
		await waitFor(() => tools.includes('WebSearch'));
		await append([
			{
				type: 'user',
				sessionId: ID_A,
				timestamp: at(20),
				message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
			},
			// One reply, written as a thinking record and a text record, both ending the turn.
			{
				type: 'assistant',
				sessionId: ID_A,
				timestamp: at(30),
				message: {
					id: 'm2',
					stop_reason: 'end_turn',
					content: [{ type: 'thinking', thinking: '' }],
				},
			},
			{
				type: 'assistant',
				sessionId: ID_A,
				timestamp: at(31),
				message: { id: 'm2', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] },
			},
			{ type: 'system', subtype: 'turn_duration', sessionId: ID_A, timestamp: at(40) },
		]);
		await waitFor(() => ends.length > 0);
		await sessionFile(home, 7, { sessionId: ID_A, cwd, status: 'idle' }, start);
		await waitFor(() => running.running()[0]?.status === 'idle');
		await sleep(150);
		assert.equal(ends.length, 1, `turn ended ${ends.length} times: ${ends.join(', ')}`);
		assert.match(ends[0] ?? '', /^completed@/);
	} finally {
		// Always stop: open watchers would otherwise keep the test process alive.
		await aya?.stop();
		await rm(home, { recursive: true, force: true });
	}
});

async function bindIdleWithHistory(records: (t: (ms: number) => string) => unknown[]) {
	const home = await mkdtemp(join(tmpdir(), 'aya-cc-'));
	const now = Date.now();
	const start = now - 5000;
	const procs = fakeProcesses(start);
	procs.set(8, true, start);
	const t = (ms: number) => new Date(start + ms).toISOString();
	let aya: ReturnType<typeof AllYourAgents> | undefined;
	try {
		await journal(home, '/tmp/app', ID_A, records(t));
		// Went idle after every record above.
		await sessionFile(
			home,
			8,
			{ sessionId: ID_A, cwd: '/tmp/app', status: 'idle', statusUpdatedAt: now - 100 },
			start,
		);
		aya = AllYourAgents({ providers: [claudeCode({ home })], processes: procs });
		await aya.start();
		return aya.running()[0]?.activity;
	} finally {
		await aya?.stop();
		await rm(home, { recursive: true, force: true });
	}
}

const toolTurn = (t: (ms: number) => string, id: string) => [
	{ type: 'user', sessionId: ID_A, timestamp: t(0), message: { content: 'search' } },
	{
		type: 'assistant',
		sessionId: ID_A,
		timestamp: t(10),
		message: {
			id: `${id}-a`,
			stop_reason: 'tool_use',
			content: [{ type: 'tool_use', id: `${id}-tool`, name: 'WebSearch', input: {} }],
		},
	},
	{
		type: 'user',
		sessionId: ID_A,
		timestamp: t(20),
		message: { content: [{ type: 'tool_result', tool_use_id: `${id}-tool`, content: 'ok' }] },
	},
	{
		type: 'assistant',
		sessionId: ID_A,
		timestamp: t(30),
		message: { id: `${id}-b`, stop_reason: 'end_turn', content: [{ type: 'thinking' }] },
	},
	{
		type: 'assistant',
		sessionId: ID_A,
		timestamp: t(31),
		message: { id: `${id}-b`, stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] },
	},
	{ type: 'system', subtype: 'turn_duration', sessionId: ID_A, timestamp: t(40) },
];

test('bind replay: finished turns before going idle stay completed', async () => {
	const activity = await bindIdleWithHistory((t) => [
		...toolTurn(t, 'one'),
		...toolTurn((ms) => t(1000 + ms), 'two'),
	]);
	assert.equal(activity?.lastTurn, 'completed');
	assert.equal(activity?.tool, undefined);
});

test('bind replay: a tool still open when the session went idle is interrupted', async () => {
	const activity = await bindIdleWithHistory((t) => [
		...toolTurn(t, 'one'),
		...toolTurn((ms) => t(1000 + ms), 'two').slice(0, 2),
	]);
	assert.equal(activity?.lastTurn, 'interrupted');
	assert.equal(activity?.tool, undefined);
});
