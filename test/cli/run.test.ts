import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { LEAVE_SCREEN, stripAnsi } from '../../src/cli/ansi.js';
import { run } from '../../src/cli/run.js';
import { installTimerGuard } from '../../src/helpers/no-timers.js';
import { AllYourAgents, type Provider } from '../../src/index.js';
import { createMemoryHarness } from '../../src/testing/index.js';
import { sleep, waitFor } from '../util/wait.js';

const processes = {
	info: async () => ({ alive: true }),
	watch: () => 'unsupported' as const,
};

class FakeOut extends EventEmitter {
	chunks: string[] = [];
	isTTY: boolean;
	columns = 120;
	rows = 20;
	constructor(isTTY: boolean) {
		super();
		this.isTTY = isTTY;
	}
	write(chunk: string, cb?: () => void) {
		this.chunks.push(chunk);
		cb?.();
		return true;
	}
	get text() {
		return this.chunks.join('');
	}
	/** Frames are the writes that start at cursor home. */
	get frames() {
		return this.chunks.filter((c) => c.startsWith('\x1b[H'));
	}
	get lastFrame() {
		return stripAnsi(this.frames.at(-1) ?? '');
	}
}

function fakeIn() {
	const stdin = new PassThrough() as PassThrough & {
		isTTY: boolean;
		raw: boolean[];
		setRawMode(mode: boolean): void;
	};
	stdin.isTTY = true;
	stdin.raw = [];
	stdin.setRawMode = (mode) => {
		stdin.raw.push(mode);
	};
	return stdin;
}

function setup(
	opts: {
		tty?: boolean;
		argv?: string[];
		env?: Record<string, string>;
		providers?: Provider[];
	} = {},
) {
	const { provider, driver } = createMemoryHarness();
	const stdout = new FakeOut(opts.tty ?? true);
	const stderr = new FakeOut(false);
	const stdin = fakeIn();
	const proc = new EventEmitter();
	let instance: ReturnType<typeof AllYourAgents> | undefined;
	const start = () =>
		run({
			argv: opts.argv ?? [],
			stdin,
			stdout,
			stderr,
			env: opts.env ?? {},
			proc,
			version: '9.9.9',
			createInstance: () => {
				instance = AllYourAgents({
					providers: [provider, ...(opts.providers ?? [])],
					processes,
				});
				return instance;
			},
		});
	const key = (str: string | undefined, name?: string, ctrl = false) =>
		stdin.emit('keypress', str, { name: name ?? str, ctrl, sequence: str });
	return { driver, stdout, stderr, stdin, proc, start, key, instance: () => instance };
}

test('--version and --help print and exit 0; unknown flag exits 2', async () => {
	const v = setup({ argv: ['--version'] });
	assert.equal(await v.start(), 0);
	assert.equal(v.stdout.text, '9.9.9\n');
	const h = setup({ argv: ['--help'] });
	assert.equal(await h.start(), 0);
	assert.match(h.stdout.text, /Usage: all-your-agents/);
	const bad = setup({ argv: ['--bogus'] });
	assert.equal(await bad.start(), 2);
	assert.match(bad.stderr.text, /unknown option '--bogus'/);
	assert.equal(bad.stdout.text, '');
});

test('piped stdout prints a plain table and exits', async () => {
	const t = setup({ tty: false });
	await t.driver.createLiveSession({ id: 'a', pid: 11, status: 'busy', title: 'One' });
	await t.driver.createLiveSession({ id: 'b', pid: 12, status: 'idle', title: 'Two' });
	assert.equal(await t.start(), 0);
	const lines = t.stdout.text.trimEnd().split('\n');
	assert.equal(lines.length, 3);
	assert.match(lines[0] ?? '', /^STATUS/);
	assert.match(lines[1] ?? '', /^running\s+11\s+Memory\s+One/);
	assert.ok(!t.stdout.text.includes('\x1b'));
	assert.equal(t.stdin.raw.length, 0);
});

test('--once on a TTY honours NO_COLOR', async () => {
	const t = setup({ argv: ['--once'], env: { NO_COLOR: '1' } });
	await t.driver.createLiveSession({ id: 'a', pid: 11, status: 'busy' });
	assert.equal(await t.start(), 0);
	assert.ok(!t.stdout.text.includes('\x1b'));
	const c = setup({ argv: ['--once'] });
	await c.driver.createLiveSession({ id: 'a', pid: 11, status: 'busy' });
	assert.equal(await c.start(), 0);
	assert.ok(c.stdout.text.includes('\x1b['));
});

test('--json prints [] with no sessions, and the sessions otherwise', async () => {
	const empty = setup({ argv: ['--json'] });
	assert.equal(await empty.start(), 0);
	assert.equal(empty.stdout.text, '[]\n');
	const t = setup({ argv: ['--json'] });
	await t.driver.createLiveSession({ id: 'a', pid: 11, status: 'waiting' });
	assert.equal(await t.start(), 0);
	const rows = JSON.parse(t.stdout.text);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].status, 'waiting');
	assert.equal(rows[0].pid, 11);
});

test('TUI shows live sessions and follows changes, quit restores the terminal', async () => {
	const t = setup();
	await t.driver.createLiveSession({ id: 'a', pid: 11, status: 'busy', title: 'Alpha' });
	await t.driver.createLiveSession({ id: 'b', pid: 12, status: 'idle', title: 'Beta' });
	const exit = t.start();
	assert.ok((t.stdout.chunks[0] ?? '').includes('\x1b[?1049h'));
	assert.deepEqual(t.stdin.raw, [true]);
	await waitFor(() => /2 live/.test(t.stdout.lastFrame));
	assert.match(t.stdout.lastFrame, /1 running {2}1 idle/);

	await t.driver.createLiveSession({ id: 'c', pid: 13, status: 'idle', title: 'Gamma' });
	await waitFor(() => /Gamma/.test(t.stdout.lastFrame));

	await t.driver.rewriteStatus('a', 'waiting');
	await waitFor(() => /1 waiting/.test(t.stdout.lastFrame));

	await t.driver.remove('b');
	await waitFor(() => !/Beta/.test(t.stdout.lastFrame));
	assert.match(t.stdout.lastFrame, /2 live/);

	t.stdout.columns = 50;
	t.stdout.emit('resize');
	await waitFor(() => t.stdout.lastFrame.split('\r\n')[1]?.length === 50);

	t.key('q');
	assert.equal(await exit, 0);
	assert.ok(t.stdout.text.endsWith(LEAVE_SCREEN));
	assert.deepEqual(t.stdin.raw, [true, false]);
	assert.equal(t.proc.listenerCount('SIGINT'), 0);
	assert.equal(t.stdin.listenerCount('keypress'), 0);
});

test('ten synchronous events produce one frame', async () => {
	const t = setup();
	const exit = t.start();
	await waitFor(() => /0 live/.test(t.stdout.lastFrame));
	const before = t.stdout.frames.length;
	for (let i = 0; i < 10; i++)
		t.driver.createLiveSession({ id: `s${i}`, pid: 100 + i, status: 'busy' });
	await sleep(0);
	assert.equal(t.stdout.frames.length, before + 1);
	assert.match(t.stdout.lastFrame, /10 live/);
	t.key('q');
	assert.equal(await exit, 0);
});

test('detail view fetches subagents once and ignores late results', async () => {
	const t = setup();
	await t.driver.createLiveSession({ id: 'a', pid: 11, status: 'busy' });
	const exit = t.start();
	await waitFor(() => /1 live/.test(t.stdout.lastFrame));
	await t.driver.launchForegroundSubagent('a');
	await t.driver.finishForegroundSubagent('a', 'fg-a');
	await t.driver.launchBackgroundSubagent('a');
	t.key('\r', 'return');
	await waitFor(() => /Subagents \(2\)/.test(t.stdout.lastFrame));
	assert.match(t.stdout.lastFrame, /completed\s+Explore/);
	assert.match(t.stdout.lastFrame, /running\s+Explore\s+-\s+background/);
	t.key('\r', 'return');
	t.key(undefined, 'escape');
	t.key('q');
	assert.equal(await exit, 0);
});

test('raw terminal bytes drive the keys, including a lone Esc', async () => {
	const t = setup();
	await t.driver.createLiveSession({ id: 'a', pid: 11, status: 'busy', title: 'Alpha' });
	await t.driver.createLiveSession({ id: 'b', pid: 12, status: 'idle', title: 'Beta' });
	const exit = t.start();
	await waitFor(() => /2 live/.test(t.stdout.lastFrame));

	t.stdin.write('\x1b[B'); // down arrow
	await waitFor(() => /^> idle .*Beta/m.test(t.stdout.lastFrame));

	t.stdin.write('\r');
	await waitFor(() => /Session\s+b/.test(t.stdout.lastFrame));
	t.stdin.write('\x1b');
	await waitFor(() => /STATUS/.test(t.stdout.lastFrame), 3000);

	t.stdin.write('/alp\r');
	await waitFor(() => /filter: alp 1\/2/.test(t.stdout.lastFrame));
	t.stdin.write('\x1b');
	await waitFor(() => !/filter:/.test(t.stdout.lastFrame), 3000);

	t.stdin.write('?');
	await waitFor(() => /Keys/.test(t.stdout.lastFrame));
	t.stdin.write('\x1b');
	await waitFor(() => /STATUS/.test(t.stdout.lastFrame), 3000);

	t.stdin.write('q');
	assert.equal(await exit, 0);
});

test('provider errors show on the status line without crashing', async () => {
	const broken: Provider = {
		id: 'broken',
		harness: 'Broken',
		watch() {
			throw new Error('cannot watch');
		},
	};
	const t = setup({ providers: [broken] });
	await t.driver.createLiveSession({ id: 'a', pid: 11, status: 'busy' });
	const exit = t.start();
	await waitFor(() => /error \[broken\] cannot watch/.test(t.stdout.lastFrame));
	assert.match(t.stdout.lastFrame, /1 live/);
	await t.driver.rewriteStatus('a', 'waiting');
	await waitFor(() => /1 waiting/.test(t.stdout.lastFrame));
	t.key('x');
	await waitFor(() => !/cannot watch/.test(t.stdout.lastFrame));
	t.key('q');
	assert.equal(await exit, 0);
});

test('SIGINT exits 0 and restores', async () => {
	const t = setup();
	const exit = t.start();
	await waitFor(() => /0 live/.test(t.stdout.lastFrame));
	t.proc.emit('SIGINT');
	assert.equal(await exit, 0);
	assert.ok(t.stdout.text.endsWith(LEAVE_SCREEN));
});

test('crash restores the terminal before printing the error', async () => {
	const t = setup();
	const exit = t.start();
	await waitFor(() => /0 live/.test(t.stdout.lastFrame));
	let restoredFirst = false;
	const write = t.stderr.write.bind(t.stderr);
	t.stderr.write = (chunk: string, cb?: () => void) => {
		restoredFirst = t.stdout.text.endsWith(LEAVE_SCREEN);
		return write(chunk, cb);
	};
	t.proc.emit('uncaughtException', new Error('kaboom'));
	assert.equal(await exit, 1);
	assert.ok(restoredFirst);
	assert.match(t.stderr.text, /kaboom/);
	assert.deepEqual(t.stdin.raw, [true, false]);
});

test('idle TUI holds no timers and writes no frames', async () => {
	const t = setup();
	await t.driver.createLiveSession({ id: 'a', pid: 11, status: 'busy' });
	const exit = t.start();
	await waitFor(() => /1 live/.test(t.stdout.lastFrame));
	await sleep(20);
	const guard = installTimerGuard();
	try {
		const frames = t.stdout.frames.length;
		// An idle window measured in event-loop turns, so the wait itself arms no timer.
		for (let i = 0; i < 200; i++) await new Promise<void>((resolve) => setImmediate(resolve));
		guard.assertIdle();
		assert.equal(t.stdout.frames.length, frames);
	} finally {
		guard.restore();
	}
	t.key('q');
	assert.equal(await exit, 0);
});
