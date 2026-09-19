import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AllYourAgents } from '../../../src/index.js';
import { claudeCode } from '../../../src/providers/claude-code/index.js';
import { encodeProjectDir } from '../../../src/providers/claude-code/paths.js';
import { sleep, waitFor } from '../../util/wait.js';
import { fakeProcesses, journal, sessionFile } from './home.js';

const ID_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const cwd = '/tmp/app';

async function withHome(
	pid: number,
	run: (home: string, start: number, procs: ReturnType<typeof fakeProcesses>) => Promise<void>,
) {
	const home = await mkdtemp(join(tmpdir(), 'aya-cc-'));
	const start = Date.now() - 500;
	const procs = fakeProcesses(start);
	procs.set(pid, true, start);
	try {
		await run(home, start, procs);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

test('busy, shell, busy, idle: a background shell is waiting, not idle', async () => {
	await withHome(11, async (home, start, procs) => {
		await sessionFile(home, 11, { sessionId: ID_A, cwd, status: 'busy' }, start);
		const aya = AllYourAgents({
			providers: [claudeCode({ home })],
			processes: procs,
			debounce: { quietMs: 10 },
		});
		try {
			const log: string[] = [];
			aya.on('session:status', (s) => log.push(`${s.status}:${s.waitingFor ?? ''}`));
			await aya.start();
			assert.deepEqual(log, ['running:']);
			for (const [word, seen] of [
				['shell', 'waiting:shell'],
				['busy', 'running:'],
				['idle', 'idle:'],
			] as const) {
				await sessionFile(home, 11, { sessionId: ID_A, cwd, status: word }, start);
				await waitFor(() => log.at(-1) === seen);
			}
			assert.deepEqual(log, ['running:', 'waiting:shell', 'running:', 'idle:']);
			assert.equal('waitingFor' in (aya.running()[0] ?? {}), false);
		} finally {
			await aya.stop();
		}
	});
});

test('shell then idle: both are reported, and the turn ends once, at shell', async () => {
	await withHome(12, async (home, start, procs) => {
		const path = join(home, 'projects', encodeProjectDir(cwd), `${ID_A}.jsonl`);
		const at = (ms: number) => new Date(Date.now() + ms).toISOString();
		await journal(home, cwd, ID_A, [
			{ type: 'user', sessionId: ID_A, timestamp: at(-400), message: { content: 'hi' } },
		]);
		await sessionFile(home, 12, { sessionId: ID_A, cwd, status: 'busy' }, start);
		const aya = AllYourAgents({
			providers: [claudeCode({ home })],
			processes: procs,
			debounce: { quietMs: 5, maxLatencyMs: 50 },
		});
		try {
			const ends: string[] = [];
			const statuses: string[] = [];
			aya.on('session:activity', (s, meta) => {
				if (meta.catchUp || !s.activity.lastTurn) return;
				ends.push(`${s.activity.lastTurn}@${s.activity.lastTurnEndedAt}`);
			});
			aya.on('session:status', (s) => statuses.push(`${s.status}:${s.waitingFor ?? ''}`));
			await aya.start();
			// The reply launches a background command and ends the turn.
			await appendFile(
				path,
				`${JSON.stringify({
					type: 'assistant',
					sessionId: ID_A,
					timestamp: at(0),
					message: { id: 'm1', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] },
				})}\n`,
			);
			await waitFor(() => ends.length === 1);
			await sessionFile(
				home,
				12,
				{ sessionId: ID_A, cwd, status: 'shell', statusUpdatedAt: Date.now() + 100 },
				start,
			);
			await waitFor(() => statuses.at(-1) === 'waiting:shell');
			const session = aya.running()[0];
			assert.equal(session?.activity.lastTurn, 'completed');
			const endedAt = session?.activity.lastTurnEndedAt;
			await sessionFile(
				home,
				12,
				{ sessionId: ID_A, cwd, status: 'idle', statusUpdatedAt: Date.now() + 5000 },
				start,
			);
			await waitFor(() => statuses.at(-1) === 'idle:');
			await sleep(150);
			assert.equal(ends.length, 1, `turn ended ${ends.length} times: ${ends.join(', ')}`);
			assert.equal(aya.running()[0]?.activity.lastTurnEndedAt, endedAt);
		} finally {
			await aya.stop();
		}
	});
});

test('shell with no recorded turn end closes the open turn, as idle does', async () => {
	await withHome(13, async (home, start, procs) => {
		const at = (ms: number) => new Date(Date.now() + ms).toISOString();
		await journal(home, cwd, ID_A, [
			{ type: 'user', sessionId: ID_A, timestamp: at(-400), message: { content: 'hi' } },
		]);
		await sessionFile(home, 13, { sessionId: ID_A, cwd, status: 'busy' }, start);
		const aya = AllYourAgents({
			providers: [claudeCode({ home })],
			processes: procs,
			debounce: { quietMs: 10 },
		});
		try {
			await aya.start();
			assert.equal(aya.running()[0]?.activity.lastTurn, undefined);
			await sessionFile(home, 13, { sessionId: ID_A, cwd, status: 'shell' }, start);
			await waitFor(() => aya.running()[0]?.activity.lastTurn !== undefined);
			assert.equal(aya.running()[0]?.status, 'waiting');
		} finally {
			await aya.stop();
		}
	});
});

test('bound while in shell: catch-up is waiting for shell, replay cut at statusUpdatedAt', async () => {
	await withHome(14, async (home, start, procs) => {
		const now = Date.now();
		const t = (ms: number) => new Date(now - 5000 + ms).toISOString();
		await journal(home, cwd, ID_A, [
			{ type: 'user', sessionId: ID_A, timestamp: t(0), message: { content: 'watch it' } },
			{
				type: 'assistant',
				sessionId: ID_A,
				timestamp: t(10),
				message: {
					id: 'a',
					stop_reason: 'tool_use',
					content: [{ type: 'tool_use', id: 'tool-1', name: 'WebSearch', input: {} }],
				},
			},
		]);
		await sessionFile(
			home,
			14,
			{ sessionId: ID_A, cwd, status: 'shell', statusUpdatedAt: now - 100 },
			start,
		);
		const aya = AllYourAgents({ providers: [claudeCode({ home })], processes: procs });
		try {
			const log: string[] = [];
			aya.on('session:status', (s, meta) =>
				log.push(`${s.status}:${s.waitingFor ?? ''}:${meta.catchUp}`),
			);
			await aya.start();
			assert.deepEqual(log, ['waiting:shell:true']);
			// The tool left open before the session went to shell was cut off there.
			const activity = aya.running()[0]?.activity;
			assert.equal(activity?.tool, undefined);
			assert.equal(activity?.lastTurn, 'interrupted');
		} finally {
			await aya.stop();
		}
	});
});

test('at shell a foreground agent is cancelled and a background one keeps running', async () => {
	await withHome(15, async (home, start, procs) => {
		const at = (ms: number) => new Date(Date.now() + ms).toISOString();
		const launch = (id: string, background: boolean) => ({
			type: 'tool_use',
			id,
			name: 'Agent',
			input: { description: id, run_in_background: background },
		});
		await journal(home, cwd, ID_A, [
			{ type: 'user', sessionId: ID_A, timestamp: at(-400), message: { content: 'go' } },
		]);
		await sessionFile(home, 15, { sessionId: ID_A, cwd, status: 'busy' }, start);
		const aya = AllYourAgents({
			providers: [claudeCode({ home })],
			processes: procs,
			debounce: { quietMs: 10 },
		});
		try {
			const log: string[] = [];
			aya.on('subagent:start', (s) => log.push(`start:${s.id}:${s.background}`));
			aya.on('subagent:end', (s) => log.push(`end:${s.id}:${s.status}`));
			await aya.start();
			await appendFile(
				join(home, 'projects', encodeProjectDir(cwd), `${ID_A}.jsonl`),
				`${JSON.stringify({
					type: 'assistant',
					sessionId: ID_A,
					timestamp: at(0),
					message: {
						id: 'm1',
						stop_reason: 'tool_use',
						content: [launch('fg', false), launch('bg', true)],
					},
				})}\n`,
			);
			await waitFor(() => log.length === 2);
			await sessionFile(home, 15, { sessionId: ID_A, cwd, status: 'shell' }, start);
			await waitFor(() => log.includes('end:fg:cancelled'));
			assert.equal(aya.running()[0]?.status, 'waiting');
			// The background shell finishes without waking Claude; only the agent is left.
			await sessionFile(home, 15, { sessionId: ID_A, cwd, status: 'idle' }, start);
			await waitFor(() => aya.running()[0]?.status === 'idle');
			await sleep(100);
			assert.deepEqual(log, ['start:fg:false', 'start:bg:true', 'end:fg:cancelled']);
			assert.equal(aya.running()[0]?.activity.openSubagents, 1);
		} finally {
			await aya.stop();
		}
	});
});
