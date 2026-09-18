import assert from 'node:assert/strict';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AllYourAgents } from '../../../src/index.js';
import { codexCli } from '../../../src/providers/codex-cli/index.js';
import { spyFs } from '../../util/spy-fs.js';
import { sleep, waitFor } from '../../util/wait.js';
import { A, eventMsg, fakeCodexProcesses, rolloutPath, sessionMeta, writeRollout } from './home.js';

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
	const home = await mkdtemp(join(tmpdir(), 'aya-codex-life-'));
	try {
		await fn(home);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

test('file removed while binding: create then close, no jsonl watch left', async () => {
	await withHome(async (home) => {
		const start = Date.now() - 1000;
		const procs = fakeCodexProcesses(start);
		procs.set(8, true, start);
		const path = rolloutPath(home, A);
		const fs = spyFs();
		const inner = fs.readRange.bind(fs);
		let n = 0;
		fs.readRange = async (p, s, e) => {
			const bytes = await inner(p, s, e);
			if (p === path) {
				n++;
				if (n === 2) {
					procs.drop(8, path);
					await unlink(path);
				}
			}
			return bytes;
		};
		const aya = AllYourAgents({
			providers: [codexCli({ home })],
			processes: procs,
			fs,
			debounce: { quietMs: 10 },
		});
		const events: string[] = [];
		aya.on('session:create', () => events.push('create'));
		aya.on('session:open', () => events.push('open'));
		aya.on('session:close', () => events.push('close'));
		await aya.start();
		await writeRollout(path, [sessionMeta(A), eventMsg('task_started')]);
		procs.hold(8, path);
		await waitFor(() => events.includes('close'));
		assert.ok(events.includes('create') || events.includes('open'));
		assert.equal(aya.running().length, 0);
		assert.equal(
			fs.openWatches().some((w) => w.endsWith('.jsonl')),
			false,
		);
		await aya.stop();
	});
});

test('process exits while the journal is being read: closed, no session watch', async () => {
	await withHome(async (home) => {
		const start = Date.now() - 1000;
		const procs = fakeCodexProcesses(start);
		procs.set(8, true, start);
		const path = rolloutPath(home, A);
		await writeRollout(path, [sessionMeta(A), eventMsg('task_started')]);
		procs.hold(8, path);
		const fs = spyFs();
		const inner = fs.readRange.bind(fs);
		let n = 0;
		fs.readRange = async (p, s, e) => {
			const bytes = await inner(p, s, e);
			if (p === path) {
				n++;
				if (n === 2) procs.fire(8);
			}
			return bytes;
		};
		const aya = AllYourAgents({
			providers: [codexCli({ home })],
			processes: procs,
			fs,
			debounce: { quietMs: 10 },
		});
		const events: string[] = [];
		aya.on('session:close', () => events.push('close'));
		await aya.start();
		await waitFor(() => events.includes('close'));
		await sleep(40);
		// The tail is gone; only the watch that notices a later resume remains.
		assert.deepEqual(
			fs.openWatches().filter((w) => w.endsWith('.jsonl')),
			[path],
		);
		await aya.stop();
		assert.deepEqual(fs.openWatches(), []);
	});
});

test('stopped while binding: no event and no watch', async () => {
	await withHome(async (home) => {
		const start = Date.now() - 1000;
		const procs = fakeCodexProcesses(start);
		procs.set(8, true, start);
		const path = rolloutPath(home, A);
		const fs = spyFs();
		const inner = fs.readRange.bind(fs);
		let stopped: Promise<void> | undefined;
		fs.readRange = async (p, s, e) => {
			if (!stopped && p === path) {
				stopped = aya.stop();
				await stopped;
			}
			return inner(p, s, e);
		};
		const aya = AllYourAgents({
			providers: [codexCli({ home })],
			processes: procs,
			fs,
			debounce: { quietMs: 10 },
		});
		const events: string[] = [];
		aya.on('session:create', () => events.push('create'));
		aya.on('session:open', () => events.push('open'));
		await aya.start();
		await writeRollout(path, [sessionMeta(A)]);
		procs.hold(8, path);
		await waitFor(() => Boolean(stopped));
		await stopped;
		await sleep(40);
		assert.deepEqual(events, []);
		assert.deepEqual(fs.openWatches(), []);
	});
});
