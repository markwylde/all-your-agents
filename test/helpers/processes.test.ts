import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { installTimerGuard } from '../../src/helpers/no-timers.js';
import { createLocalProcesses } from '../../src/helpers/processes.js';

test('processes.info for the current process is close to now - uptime', async () => {
	const procs = createLocalProcesses({ koffi: false });
	const info = await procs.info(process.pid);
	assert.equal(info.alive, true);
	assert.ok(info.startTime != null);
	const expected = Date.now() - process.uptime() * 1000;
	assert.ok(
		Math.abs((info.startTime ?? 0) - expected) < 5000,
		`startTime ${info.startTime} vs ${expected}`,
	);
	procs.close();
});

test('dead pid reports alive: false', async () => {
	const procs = createLocalProcesses({ koffi: false });
	const info = await procs.info(999_999_999);
	assert.equal(info.alive, false);
	procs.close();
});

test('koffi stubbed out → unsupported', () => {
	const procs = createLocalProcesses({ koffi: false });
	assert.equal(
		procs.watch(process.pid, () => {}),
		'unsupported',
	);
	procs.close();
});

test('detached sleep not spawned as a child triggers onExit', async (t) => {
	// `watch` answers before the worker has said whether the native wait works at all:
	// `unsupported` only arrives as a message, so watch a throwaway child and wait for
	// either its exit (native wait works) or the deadline (unsupported).
	const throwaway = spawn('sleep', ['30'], { stdio: 'ignore' });
	const probe = createLocalProcesses();
	let supported = false;
	{
		// `Promise.withResolvers` is Node 22+; `engines` allows Node 20.
		const promise = new Promise<void>((resolve) => {
			const handle = probe.watch(throwaway.pid ?? 0, () => {
				supported = true;
				resolve();
			});
			if (handle === 'unsupported') resolve();
			else setTimeout(resolve, 2000);
			throwaway.kill('SIGKILL');
		});
		await promise;
	}
	await probe.close();
	if (!supported) {
		t.skip('koffi watch unsupported');
		return;
	}
	// `sleep` is parented by `sh`, which stays alive to reap it: its death is then visible
	// to `kill(pid, 0)` on machines with no reaping init. It is still no child of ours.
	const babysitter = spawn('sh', ['-c', 'sleep 30 & echo $!; wait'], {
		stdio: ['ignore', 'pipe', 'ignore'],
	});
	const pid = await new Promise<number>((resolve) => {
		let out = '';
		babysitter.stdout.on('data', (chunk: Buffer) => {
			out += chunk.toString();
			const line = out.split('\n', 1)[0]?.trim();
			if (line) resolve(Number(line));
		});
	});
	assert.ok(pid > 0);
	const live = createLocalProcesses();
	try {
		process.kill(pid, 0);
		let exitedAt: number | undefined;
		const handle = live.watch(pid, () => {
			exitedAt = Date.now();
		});
		assert.notEqual(handle, 'unsupported');
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(exitedAt, undefined, 'onExit before the process exited');
		process.kill(pid, 'SIGTERM');
		let diedAt: number | undefined;
		const started = Date.now();
		while (Date.now() - started < 3000) {
			try {
				process.kill(pid, 0);
			} catch {
				diedAt ??= Date.now();
			}
			if (exitedAt != null && diedAt != null) break;
			await new Promise((r) => setTimeout(r, 5));
		}
		assert.ok(exitedAt != null, 'onExit not called');
		assert.ok(diedAt != null, 'process never exited');
		assert.ok(
			Math.abs((exitedAt ?? 0) - (diedAt ?? 0)) < 250,
			`onExit lag ${(exitedAt ?? 0) - (diedAt ?? 0)}ms`,
		);
		if (handle !== 'unsupported') handle.stop();
	} finally {
		try {
			process.kill(pid, 'SIGKILL');
		} catch {
			// already gone
		}
		babysitter.kill('SIGKILL');
		await live.close();
	}
});

test('stop() ends the worker and no timer is armed', async () => {
	const guard = installTimerGuard();
	try {
		const procs = createLocalProcesses();
		const handle = procs.watch(process.pid, () => {});
		if (handle !== 'unsupported') handle.stop();
		await procs.close();
		guard.assertIdle();
	} finally {
		guard.restore();
	}
});

test('close() waits for the worker so the process can exit without aborting', async (t) => {
	const probe = createLocalProcesses();
	const probeHandle = probe.watch(process.pid, () => {});
	await probe.close();
	if (probeHandle === 'unsupported') {
		t.skip('koffi watch unsupported');
		return;
	}
	const helpers = new URL('../../src/helpers/processes.js', import.meta.url).href;
	// Close at different points in the worker's life: while koffi is still loading, and
	// while a native wait is in flight. Exiting afterwards must never abort the process.
	for (const delay of [0, 0, 5, 50, 200]) {
		const script = `
			import { createLocalProcesses } from ${JSON.stringify(helpers)};
			const procs = createLocalProcesses();
			procs.watch(process.pid, () => {});
			await new Promise((r) => setTimeout(r, ${delay}));
			await procs.close();
		`;
		const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
			encoding: 'utf8',
			timeout: 10_000,
		});
		assert.equal(result.status, 0, `delay ${delay}: ${result.stderr.slice(0, 300)}`);
	}
});

test('claude and grok providers do not call holders', async () => {
	const { readdirSync, readFileSync, statSync } = await import('node:fs');
	const { dirname, join } = await import('node:path');
	const { fileURLToPath } = await import('node:url');
	const src = join(dirname(fileURLToPath(import.meta.url)), '../../src/providers');
	const walk = (dir: string): string[] => {
		const out: string[] = [];
		for (const name of readdirSync(dir)) {
			const full = join(dir, name);
			if (statSync(full).isDirectory()) out.push(...walk(full));
			else if (full.endsWith('.ts')) out.push(full);
		}
		return out;
	};
	for (const name of ['claude-code', 'grok-build']) {
		for (const file of walk(join(src, name))) {
			assert.equal(/holders|heldUnder/.test(readFileSync(file, 'utf8')), false, file);
		}
	}
});

test('holders and heldUnder see a child with a file open, and arm no timer', async () => {
	const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
	const { tmpdir } = await import('node:os');
	const { join } = await import('node:path');
	const dir = await mkdtemp(join(tmpdir(), 'aya-hold-'));
	const file = join(dir, 'rollout.jsonl');
	await writeFile(file, '{}\n');
	const child = spawn(
		process.execPath,
		['-e', `require('fs').openSync(${JSON.stringify(file)}, 'r'); setInterval(() => {}, 1e6)`],
		{ stdio: 'ignore' },
	);
	const procs = createLocalProcesses({ koffi: false });
	const guard = installTimerGuard();
	try {
		assert.ok(child.pid);
		const holders = procs.holders;
		const heldUnder = procs.heldUnder;
		assert.ok(holders && heldUnder);
		let pids: number[] = [];
		const started = Date.now();
		while (Date.now() - started < 3000) {
			pids = await holders(file);
			if (child.pid != null && pids.includes(child.pid)) break;
			await new Promise((r) => setTimeout(r, 50));
		}
		assert.ok(child.pid != null && pids.includes(child.pid), `holders ${pids.join(',')}`);
		const under = await heldUnder(dir);
		assert.ok(under.some((row) => row.pid === child.pid && row.path === file));
		guard.assertIdle();
	} finally {
		guard.restore();
		child.kill();
		await procs.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test('holders and heldUnder never report this process', async () => {
	const { mkdtemp, writeFile, rm, open } = await import('node:fs/promises');
	const { watch } = await import('node:fs');
	const { tmpdir } = await import('node:os');
	const { join } = await import('node:path');
	const dir = await mkdtemp(join(tmpdir(), 'aya-self-'));
	const file = join(dir, 'rollout.jsonl');
	await writeFile(file, '{}\n');
	// A file watch is an open fd on macOS; a read handle is one everywhere.
	const watcher = watch(file);
	const handle = await open(file, 'r');
	const procs = createLocalProcesses({ koffi: false });
	try {
		const holders = procs.holders;
		const heldUnder = procs.heldUnder;
		assert.ok(holders && heldUnder);
		assert.equal((await holders(file)).includes(process.pid), false);
		assert.equal(
			(await heldUnder(dir)).some((row) => row.pid === process.pid),
			false,
		);
	} finally {
		watcher.close();
		await handle.close();
		await procs.close();
		await rm(dir, { recursive: true, force: true });
	}
});
