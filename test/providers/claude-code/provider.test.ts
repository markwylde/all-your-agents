import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Processes } from '../../../src/helpers/types.js';
import { AllYourAgents } from '../../../src/index.js';
import { claudeCode } from '../../../src/providers/claude-code/index.js';
import { encodeProjectDir } from '../../../src/providers/claude-code/paths.js';
import type { Session } from '../../../src/types.js';
import { sleep, waitFor } from '../../util/wait.js';

const ID_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function fakeProcesses(start = Date.now() - 1000) {
	const alive = new Map<number, { alive: boolean; startTime: number }>();
	const exits = new Map<number, () => void>();
	const processes: Processes & {
		fire(pid: number): void;
		set(pid: number, a: boolean, t?: number): void;
	} = {
		async info(pid) {
			return alive.get(pid) ?? { alive: false };
		},
		watch(pid, onExit) {
			exits.set(pid, onExit);
			return {
				stop() {
					exits.delete(pid);
				},
			};
		},
		fire(pid) {
			exits.get(pid)?.();
		},
		set(pid, a, t = start) {
			if (a) alive.set(pid, { alive: true, startTime: t });
			else alive.delete(pid);
		},
	};
	return processes;
}

async function sessionFile(
	home: string,
	pid: number,
	over: Record<string, unknown>,
	start: number,
): Promise<void> {
	await mkdir(join(home, 'sessions'), { recursive: true });
	await writeFile(
		join(home, 'sessions', `${pid}.json`),
		JSON.stringify({
			pid,
			startedAt: start,
			status: 'idle',
			cwd: '/tmp/app',
			...over,
		}),
	);
}

async function journal(home: string, cwd: string, id: string, records: unknown[]): Promise<void> {
	const dir = join(home, 'projects', encodeProjectDir(cwd));
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, `${id}.jsonl`),
		`${records.map((r) => JSON.stringify(r)).join('\n')}\n`,
	);
}

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
