import assert from 'node:assert/strict';
import { closeSync, openSync, writeSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AllYourAgents } from '../../../src/index.js';
import { grokBuild } from '../../../src/providers/grok-build/index.js';
import { sleep, waitFor } from '../../util/wait.js';
import { appendLines, entry, fakeProcesses, makeSession, ts, writeIndex } from './home.js';

const A = '01a0b689-79d2-7340-92c2-439bcdcb62cf';
const B = '01a0b68e-3381-7e22-b8c3-b2497b0bd8d3';

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
	const home = await mkdtemp(join(tmpdir(), 'aya-grok-rewind-'));
	try {
		await fn(home);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

/** A turn cancelled before any output, as Grok 1.0.34 leaves it in `events.jsonl`. */
const openTurn = (at: number) => [
	{ ts: ts(at), type: 'turn_started', session_id: A, turn_number: 1, model_id: 'grok-4.6' },
	{ ts: ts(at + 30), type: 'loop_started', loop_index: 0 },
	{ ts: ts(at + 40), type: 'phase_changed', phase: 'waiting_for_model' },
];

/**
 * The only trace of that cancel: Grok rewinds the prompt and writes nothing to the
 * session directory, just these lines to its shared log.
 */
const rewind = (sid: string, pid: number, at: number, disposition = 'rewound') => [
	{
		ts: ts(at),
		src: 'shell',
		pid,
		ver: '1.0.34',
		lvl: 'info',
		sid,
		msg: 'shell.cancel.received',
		ctx: { session_found: true, trigger: 'ctrl_c' },
	},
	{
		ts: ts(at),
		src: 'shell',
		pid,
		ver: '1.0.34',
		lvl: 'info',
		sid,
		msg: 'shell.cancel.rewind_decision',
		ctx: {
			requested_prompt_id: '1e416da1-74f9-479d-a587-fb577cda7735',
			front_prompt_id: '1e416da1-74f9-479d-a587-fb577cda7735',
			rewind_disposition: disposition,
		},
	},
];

async function writeLog(home: string, records: unknown[]): Promise<void> {
	await mkdir(join(home, 'logs'), { recursive: true });
	await appendLines(join(home, 'logs', 'unified.jsonl'), records);
}

test('cancel before any output: the rewind in the log ends the turn interrupted', async () => {
	await withHome(async (home) => {
		const start = Date.now() - 5000;
		const procs = fakeProcesses(start);
		procs.set(87606, true, start);
		await writeLog(home, [{ ts: ts(start), src: 'shell', msg: 'unrelated' }]);
		await makeSession(home, '/app', A, { events: openTurn(start + 1000) });
		await writeIndex(home, [entry(A, 87606, '/app', start)]);
		const aya = AllYourAgents({
			providers: [grokBuild({ home })],
			processes: procs,
			debounce: { quietMs: 10 },
		});
		try {
			await aya.start();
			await waitFor(() => aya.running()[0]?.status === 'running');
			// Another session's rewind changes nothing here.
			await writeLog(home, rewind(B, 213, Date.now()));
			await sleep(80);
			assert.equal(aya.running()[0]?.status, 'running');
			await writeLog(home, rewind(A, 87606, Date.now()));
			await waitFor(() => aya.running()[0]?.status === 'idle');
			assert.equal(aya.running()[0]?.activity.lastTurn, 'interrupted');
		} finally {
			await aya.stop();
		}
	});
});

test('rewound before aya started: bound idle, not running', async () => {
	await withHome(async (home) => {
		const start = Date.now() - 5000;
		const procs = fakeProcesses(start);
		procs.set(87606, true, start);
		await makeSession(home, '/app', A, { events: openTurn(start + 1000) });
		await writeLog(home, rewind(A, 87606, start + 2000));
		await writeIndex(home, [entry(A, 87606, '/app', start)]);
		const aya = AllYourAgents({
			providers: [grokBuild({ home })],
			processes: procs,
			debounce: { quietMs: 10 },
		});
		try {
			await aya.start();
			await waitFor(() => aya.running()[0]?.status === 'idle');
		} finally {
			await aya.stop();
		}
	});
});

test('a rewind older than the open turn does not end it', async () => {
	await withHome(async (home) => {
		const start = Date.now() - 5000;
		const procs = fakeProcesses(start);
		procs.set(87606, true, start);
		await writeLog(home, rewind(A, 87606, start + 500));
		await makeSession(home, '/app', A, { events: openTurn(start + 1000) });
		await writeIndex(home, [entry(A, 87606, '/app', start)]);
		const aya = AllYourAgents({
			providers: [grokBuild({ home })],
			processes: procs,
			debounce: { quietMs: 10 },
		});
		try {
			await aya.start();
			await waitFor(() => aya.running()[0]?.status === 'running');
			await sleep(80);
			assert.equal(aya.running()[0]?.status, 'running');
		} finally {
			await aya.stop();
		}
	});
});

test('rewind appended through a handle Grok keeps open is still seen', async () => {
	await withHome(async (home) => {
		const start = Date.now() - 5000;
		const procs = fakeProcesses(start);
		procs.set(87606, true, start);
		await writeLog(home, [{ ts: ts(start), src: 'shell', msg: 'unrelated' }]);
		await makeSession(home, '/app', A, { events: openTurn(start + 1000) });
		await writeIndex(home, [entry(A, 87606, '/app', start)]);
		// Every Grok process holds the shared log open for append and never closes it.
		const fd = openSync(join(home, 'logs', 'unified.jsonl'), 'a');
		const aya = AllYourAgents({
			providers: [grokBuild({ home })],
			processes: procs,
			debounce: { quietMs: 10 },
		});
		try {
			await aya.start();
			await waitFor(() => aya.running()[0]?.status === 'running');
			// Past the catch-up reads that opening watches triggers.
			await sleep(300);
			for (const rec of rewind(A, 87606, Date.now())) writeSync(fd, `${JSON.stringify(rec)}\n`);
			await waitFor(() => aya.running()[0]?.status === 'idle');
		} finally {
			await aya.stop();
			closeSync(fd);
		}
	});
});
