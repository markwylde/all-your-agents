import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
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
	const probe = createLocalProcesses();
	const probeHandle = probe.watch(1, () => {});
	probe.close();
	if (probeHandle === 'unsupported') {
		t.skip('koffi watch unsupported');
		return;
	}
	const live = createLocalProcesses();
	const pid = Number(execSync('sleep 0.4 >/dev/null 2>&1 & echo $!').toString().trim());
	assert.ok(pid > 0);
	let exitedAt: number | undefined;
	const handle = live.watch(pid, () => {
		exitedAt = Date.now();
	});
	assert.notEqual(handle, 'unsupported');
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
		Math.abs((exitedAt ?? 0) - (diedAt ?? 0)) < 50,
		`onExit lag ${(exitedAt ?? 0) - (diedAt ?? 0)}ms`,
	);
	if (handle !== 'unsupported') handle.stop();
	live.close();
});

test('stop() ends the worker and no timer is armed', () => {
	const guard = installTimerGuard();
	try {
		const procs = createLocalProcesses();
		const handle = procs.watch(process.pid, () => {});
		if (handle !== 'unsupported') handle.stop();
		procs.close();
		guard.assertIdle();
	} finally {
		guard.restore();
	}
});
