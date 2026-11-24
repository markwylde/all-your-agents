import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLocalSqlite } from '../../src/helpers/sqlite.js';
import { AllYourAgents, antigravityCli } from '../../src/index.js';
import { createAntigravityFixtureDriver } from '../../src/testing/index.js';
import { waitFor } from '../util/wait.js';

const ID = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000a2';
const unsupported = !['linux', 'darwin'].includes(platform());

/** The real process probe: the pid must actually hold the presence lock open. */
test('a real holder makes the session live with its pid and cwd; exit closes it, a new holder resumes it', {
	skip: unsupported && 'holder probe needs Linux or macOS',
}, async (t) => {
	if (!(await createLocalSqlite())) return t.skip('this Node has no built-in SQLite');
	const home = await mkdtemp(join(tmpdir(), 'aya-agy-driver-'));
	const driver = createAntigravityFixtureDriver(home);
	const aya = AllYourAgents({
		providers: [antigravityCli({ home })],
		debounce: { quietMs: 10, maxLatencyMs: 100 },
	});
	const errors: unknown[] = [];
	aya.on('error', (e) => errors.push(e));
	const lifecycle: string[] = [];
	aya.on('session:create', (s) => lifecycle.push(`create:${s.id}`));
	aya.on('session:open', (s) => lifecycle.push(`open:${s.id}`));
	aya.on('session:close', (s) => lifecycle.push(`close:${s.id}`));
	try {
		await aya.start();
		const first = await driver.spawnHolder(ID);
		await driver.createLiveSession({
			id: ID,
			pid: first.pid,
			cwd: '/tmp/agy project',
			title: 'Fixture agy',
			status: 'busy',
		});
		const live = await waitFor(() => aya.running().find((s) => s.id === ID));
		assert.equal(live.pid, first.pid);
		assert.equal(live.cwd, '/tmp/agy project');
		assert.equal(live.harness, 'AntiGravity');
		assert.equal(live.title, 'Fixture agy');
		assert.equal(live.status, 'running');

		await driver.rewriteStatus(ID, 'idle');
		await waitFor(() => aya.running().find((s) => s.id === ID)?.status === 'idle');

		await first.stop();
		await waitFor(() => lifecycle.includes(`close:${ID}`));
		assert.equal(
			aya.running().some((s) => s.id === ID),
			false,
		);
		const history = (await aya.sessions()).find((s) => s.id === ID);
		assert.equal(history?.title, 'Fixture agy');
		assert.equal(history?.cwd, '/tmp/agy project');

		// Resume: another process takes the same conversation's lock.
		const second = await driver.spawnHolder(ID);
		await driver.createLiveSession({ id: ID, pid: second.pid, status: 'busy' });
		await waitFor(() => aya.running().find((s) => s.id === ID)?.pid === second.pid);
		assert.ok(lifecycle.includes(`open:${ID}`), lifecycle.join(' '));
		assert.equal(aya.running().find((s) => s.id === ID)?.cwd, '/tmp/agy project');

		await driver.remove(ID);
		await waitFor(() => !aya.running().some((s) => s.id === ID));
		assert.deepEqual(errors, []);
	} finally {
		await aya.stop();
		await driver.dispose();
		await rm(home, { recursive: true, force: true });
	}
});

test('a process the caller started holds the lock from prepareLock', {
	skip: unsupported && 'holder probe needs Linux or macOS',
}, async (t) => {
	if (!(await createLocalSqlite())) return t.skip('this Node has no built-in SQLite');
	const home = await mkdtemp(join(tmpdir(), 'aya-agy-driver-'));
	const driver = createAntigravityFixtureDriver(home);
	const aya = AllYourAgents({
		providers: [antigravityCli({ home })],
		debounce: { quietMs: 10, maxLatencyMs: 100 },
	});
	const lock = await driver.prepareLock(OTHER);
	// As a terminal would run it: the shell opens the lock, then `sleep` inherits it.
	const holder = spawn('sh', ['-c', 'exec 3>>"$0"; echo ready; exec sleep 600', lock], {
		stdio: ['ignore', 'pipe', 'inherit'],
	});
	try {
		await once(holder.stdout, 'data');
		await aya.start();
		await driver.createLiveSession({ id: OTHER, pid: holder.pid as number, cwd: '/tmp/agy-cwd' });
		const live = await waitFor(() => aya.running().find((s) => s.id === OTHER));
		assert.equal(live.pid, holder.pid);
		assert.equal(live.cwd, '/tmp/agy-cwd');
		const exited = once(holder, 'exit');
		holder.kill('SIGTERM');
		await exited;
		await waitFor(() => !aya.running().some((s) => s.id === OTHER));
	} finally {
		if (holder.exitCode == null && holder.signalCode == null) holder.kill('SIGKILL');
		await aya.stop();
		await rm(home, { recursive: true, force: true });
	}
});

test('driver steps reach the provider: tools, a failed turn, subagents, a background wait', async (t) => {
	if (!(await createLocalSqlite())) return t.skip('this Node has no built-in SQLite');
	const home = await mkdtemp(join(tmpdir(), 'aya-agy-driver-'));
	const driver = createAntigravityFixtureDriver(home);
	const aya = AllYourAgents({
		providers: [antigravityCli({ home })],
		processes: driver.processes,
		debounce: { quietMs: 10, maxLatencyMs: 100 },
	});
	const errors: unknown[] = [];
	aya.on('error', (e) => errors.push(e));
	const log: string[] = [];
	aya.on('subagent:start', (s) => log.push(`start:${s.id}:${s.parentId ?? ''}:${s.background}`));
	aya.on('subagent:end', (s) => log.push(`end:${s.id}:${s.status}`));
	const session = () => aya.running().find((s) => s.id === ID);
	try {
		await aya.start();
		await driver.createLiveSession({ id: ID, pid: 4242, cwd: '/tmp/agy', status: 'busy' });
		await waitFor(() => session()?.status === 'running');
		await driver.runTurnWithTool(ID);
		await waitFor(() => session()?.status === 'idle');
		assert.equal(session()?.activity.lastTurn, 'completed');
		const events = [];
		const stored = await aya.get(ID);
		assert.ok(stored);
		for await (const event of stored.events()) {
			events.push(event.kind === 'tool' ? `tool:${event.name}` : event.kind);
			if (events.length >= 6) break;
		}
		assert.ok(events.includes('tool:run_command'), events.join(' '));
		await driver.failTurn(ID);
		await waitFor(() => session()?.activity.lastTurn === 'failed');

		await driver.rewriteStatus(ID, 'busy');
		const fg = await driver.launchForegroundSubagent(ID);
		const nested = await driver.launchNestedSubagent(ID, fg.subagentId);
		const bg = await driver.launchBackgroundSubagent(ID);
		await waitFor(() => log.includes(`start:${bg.subagentId}::true`));
		assert.ok(log.includes(`start:${fg.subagentId}::false`), log.join(' '));
		assert.ok(log.includes(`start:${nested.subagentId}:${fg.subagentId}:false`), log.join(' '));
		await driver.finishForegroundSubagent(ID, fg.subagentId);
		await waitFor(() => log.includes(`end:${fg.subagentId}:completed`));
		await driver.finishBackgroundSubagent(ID, bg.subagentId);
		await waitFor(() => log.includes(`end:${bg.subagentId}:completed`));

		await driver.startBackgroundWait?.(ID);
		await waitFor(() => session()?.status === 'waiting' && session()?.waitingFor === 'shell');
		await driver.endBackgroundWait?.(ID);
		await waitFor(() => session()?.status === 'idle');

		await driver.updateMetadata(ID, { title: 'Renamed', cwd: '/tmp/agy-moved' });
		await waitFor(() => session()?.title === 'Renamed' && session()?.cwd === '/tmp/agy-moved');

		driver.processes.exit(4242);
		await waitFor(() => !session());
		await driver.remove(ID);
		assert.equal((await aya.sessions()).find((s) => s.id === ID)?.title, 'Renamed');
		assert.deepEqual(errors, []);
	} finally {
		await aya.stop();
		await rm(home, { recursive: true, force: true });
	}
});
