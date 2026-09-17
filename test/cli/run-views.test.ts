import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { stripAnsi } from '../../src/cli/ansi.js';
import { run } from '../../src/cli/run.js';
import { installTimerGuard } from '../../src/helpers/no-timers.js';
import { AllYourAgents, type Provider, type SessionEvent } from '../../src/index.js';
import { createMemoryHarness } from '../../src/testing/index.js';
import { waitFor } from '../util/wait.js';

const processes = { info: async () => ({ alive: true }), watch: () => 'unsupported' as const };

class FakeOut extends EventEmitter {
	chunks: string[] = [];
	isTTY: boolean;
	columns = 120;
	rows = 16;
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
	get frames() {
		return this.chunks.filter((c) => c.startsWith('\x1b[H'));
	}
	get lastFrame() {
		return stripAnsi(this.frames.at(-1) ?? '');
	}
}

const DAY = 86_400_000;

/** A provider with two finished sessions, a long stored transcript, and a tail it can append to. */
function historian(stored: SessionEvent[]) {
	const state = {
		following: 0,
		inspected: 0,
		push: undefined as ((e: SessionEvent) => void) | undefined,
	};
	const provider: Provider = {
		id: 'hist',
		harness: 'Hist',
		watch: () => () => {},
		async *list() {
			yield {
				id: 'h1',
				harness: 'Hist',
				provider: 'hist',
				title: 'Yesterday',
				updatedAt: Date.now() - DAY,
			};
			yield {
				id: 'h2',
				harness: 'Hist',
				provider: 'hist',
				title: 'Last week',
				updatedAt: Date.now() - 7 * DAY,
			};
		},
		async subagents(_ctx, id) {
			if (id !== 'h1') return [];
			const base = { sessionId: 'h1', harness: 'Hist', background: false };
			return [
				{ ...base, id: 's1', type: 'Explore', title: 'look around', status: 'completed' },
				{ ...base, id: 's2', type: 'Plan', title: 'make a plan', status: 'failed' },
			];
		},
		async *inspect(ctx, id) {
			if (id !== 'h1') return;
			state.inspected++;
			yield* stored;
			if (!ctx.follow) return;
			state.following++;
			try {
				while (!ctx.signal?.aborted) {
					const next = await new Promise<SessionEvent | undefined>((resolve) => {
						state.push = resolve;
						ctx.signal?.addEventListener('abort', () => resolve(undefined), { once: true });
					});
					if (!next) break;
					yield next;
				}
			} finally {
				state.following--;
			}
		},
	};
	return { provider, state };
}

function setup(extra: Provider, opts: { argv?: string[]; tty?: boolean } = {}) {
	const { provider, driver } = createMemoryHarness();
	const stdout = new FakeOut(opts.tty ?? true);
	const stderr = new FakeOut(false);
	const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
	const start = () =>
		run({
			argv: opts.argv ?? [],
			stdin,
			stdout,
			stderr,
			env: {},
			proc: new EventEmitter(),
			version: '9.9.9',
			createInstance: () => AllYourAgents({ providers: [provider, extra], processes }),
		});
	const key = (str: string | undefined, name?: string) =>
		stdin.emit('keypress', str, { name: name ?? str, ctrl: false, sequence: str });
	return { driver, stdout, stderr, start, key };
}

const conversation = (turns: number): SessionEvent[] => {
	const out: SessionEvent[] = [];
	for (let i = 0; i < turns; i++) {
		out.push({ kind: 'user', text: `prompt ${i}`, raw: {} });
		out.push({ kind: 'assistant', text: `reply ${i}`, model: 'claude-opus-5', raw: {} });
		out.push({ kind: 'tool', id: `t${i}`, name: 'Bash', raw: {} });
		out.push({ kind: 'turn-end', outcome: 'completed', raw: {} });
	}
	return out;
};

test('H loads history once; a historical session opens in detail with its subagents', async () => {
	const { provider } = historian([]);
	const t = setup(provider);
	await t.driver.createLiveSession({ id: 'a', pid: 11, status: 'busy', title: 'Live one' });
	const exit = t.start();
	await waitFor(() => /1 live/.test(t.stdout.lastFrame));
	assert.doesNotMatch(t.stdout.lastFrame, /Yesterday/);

	t.key('H');
	await waitFor(() => /\+history \(2\)/.test(t.stdout.lastFrame));
	assert.match(t.stdout.lastFrame, /1 live/);
	assert.match(t.stdout.lastFrame, /closed\s+-\s+Hist\s+Yesterday/);
	const rows = t.stdout.lastFrame.split('\n').filter((l) => /Live one|Yesterday|Last week/.test(l));
	assert.deepEqual(
		rows.map((l) => /Live one|Yesterday|Last week/.exec(l)?.[0]),
		['Live one', 'Yesterday', 'Last week'],
	);

	t.key(undefined, 'down');
	t.key('\r', 'return');
	await waitFor(() => /Subagents \(2\)/.test(t.stdout.lastFrame));
	assert.match(t.stdout.lastFrame, /failed\s+Plan\s+make a plan/);

	t.key(undefined, 'escape');
	t.key('H');
	await waitFor(() => !/Yesterday/.test(t.stdout.lastFrame));
	assert.match(t.stdout.lastFrame, /Live one/);
	t.key('q');
	assert.equal(await exit, 0);
});

test('--history starts with history loaded', async () => {
	const { provider } = historian([]);
	const t = setup(provider, { argv: ['--history'] });
	const exit = t.start();
	await waitFor(() => /\+history \(2\)/.test(t.stdout.lastFrame));
	assert.match(t.stdout.lastFrame, /0 live/);
	t.key('q');
	assert.equal(await exit, 0);
});

test('t streams a long transcript in a few frames, follows appends, and closing ends the stream', async () => {
	const { provider, state } = historian(conversation(1500));
	const t = setup(provider, { argv: ['--history'] });
	const exit = t.start();
	await waitFor(() => /\+history \(2\)/.test(t.stdout.lastFrame));

	const before = t.stdout.frames.length;
	t.key('t');
	await waitFor(() => /prompt 1499/.test(t.stdout.lastFrame));
	assert.ok(
		t.stdout.frames.length - before <= 5,
		`6000 stored records drew ${t.stdout.frames.length - before} frames`,
	);
	assert.match(t.stdout.lastFrame, /Transcript · Yesterday/);
	assert.match(t.stdout.lastFrame, /Agent · claude-opus-5/);
	assert.match(t.stdout.lastFrame, /⚙ Bash/);
	assert.match(t.stdout.lastFrame, /── completed/);
	assert.match(t.stdout.lastFrame, /following/);
	assert.equal(state.following, 1);

	// Nothing is pending while the transcript is open and idle.
	const guard = installTimerGuard();
	try {
		for (let i = 0; i < 50; i++) await new Promise<void>((resolve) => setImmediate(resolve));
		guard.assertIdle();
	} finally {
		guard.restore();
	}

	state.push?.({ kind: 'assistant', text: 'a late reply', raw: {} });
	await waitFor(() => /a late reply/.test(t.stdout.lastFrame));

	t.key(undefined, 'home');
	await waitFor(() => /prompt 0\b/.test(t.stdout.lastFrame));
	assert.doesNotMatch(t.stdout.lastFrame, /following/);

	t.key(undefined, 'escape');
	await waitFor(() => state.following === 0);
	assert.match(t.stdout.lastFrame, /\+history \(2\)/);
	assert.equal(state.inspected, 1, 'one stream for the whole view');
	t.key('q');
	assert.equal(await exit, 0);
});

test('quitting with a transcript open ends its stream', async () => {
	const { provider, state } = historian(conversation(2));
	const t = setup(provider, { argv: ['--history'] });
	const exit = t.start();
	await waitFor(() => /\+history \(2\)/.test(t.stdout.lastFrame));
	t.key('t');
	await waitFor(() => state.following === 1);
	t.key('q');
	assert.equal(await exit, 0);
	await waitFor(() => state.following === 0);
});

test('a session with no history shows an empty transcript, not an error', async () => {
	const { provider } = historian([]);
	const t = setup(provider);
	await t.driver.createLiveSession({ id: 'a', pid: 11, status: 'busy', title: 'Live one' });
	const exit = t.start();
	await waitFor(() => /1 live/.test(t.stdout.lastFrame));
	t.key('t');
	await waitFor(() => /No records yet/.test(t.stdout.lastFrame));
	assert.doesNotMatch(t.stdout.lastFrame, /error \[/);
	t.key('q');
	assert.equal(await exit, 0);
});

test('--json --history prints live sessions first, then history newest first', async () => {
	const { provider } = historian([]);
	const t = setup(provider, { argv: ['--json', '--history'] });
	await t.driver.createLiveSession({ id: 'a', pid: 11, status: 'busy' });
	assert.equal(await t.start(), 0);
	const rows = JSON.parse(t.stdout.text) as { id: string; pid?: number }[];
	assert.deepEqual(
		rows.map((r) => r.id),
		['a', 'h1', 'h2'],
	);
	assert.deepEqual(
		rows.map((r) => r.pid),
		[11, undefined, undefined],
	);

	const table = setup(provider, { argv: ['--once', '--history'], tty: false });
	await table.driver.createLiveSession({ id: 'a', pid: 11, status: 'busy' });
	assert.equal(await table.start(), 0);
	const lines = table.stdout.text.trimEnd().split('\n');
	assert.deepEqual(
		lines.slice(1).map((l) => l.split(/\s+/)[0]),
		['running', 'closed', 'closed'],
	);
});
