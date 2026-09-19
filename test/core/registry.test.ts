import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AllYourAgents } from '../../src/index.js';
import type { Provider, WatchContext } from '../../src/provider.js';
import type { Session, SessionEvent } from '../../src/types.js';

function scripted(
	run: (ctx: WatchContext) => void | Promise<void>,
	opts?: Partial<Provider>,
): Provider {
	return {
		id: opts?.id ?? 'mem',
		harness: opts?.harness ?? 'Memory',
		watch(ctx) {
			return Promise.resolve(run(ctx)).then(() => () => {});
		},
		...opts,
	};
}

function collect(aya: ReturnType<typeof AllYourAgents>) {
	const events: string[] = [];
	const sessionEvent = (name: string) => (session: Session) => {
		events.push(`${name}:${session.id}:${session.status ?? ''}:${session.pid ?? ''}`);
	};
	aya.on('session:create', sessionEvent('session:create'));
	aya.on('session:open', sessionEvent('session:open'));
	aya.on('session:status', sessionEvent('session:status'));
	aya.on('session:update', sessionEvent('session:update'));
	aya.on('session:close', sessionEvent('session:close'));
	aya.on('session:activity', sessionEvent('session:activity'));
	aya.on('subagent:start', (sub, session) => events.push(`subagent:start:${sub.id}:${session.id}`));
	aya.on('subagent:end', (sub, session) => events.push(`subagent:end:${sub.id}:${session.id}`));
	aya.on('ready', () => events.push('ready'));
	aya.on('error', (e) =>
		events.push(`error:${e.source === 'provider' ? e.provider : `listener:${e.event}`}`),
	);
	return events;
}

test('live registry: ordering, status dedupe, pid cleared, running()', async () => {
	const aya = AllYourAgents({
		providers: [
			scripted((ctx) => {
				ctx.emit('session:create', {
					id: 'a',
					harness: 'Memory',
					provider: 'mem',
					pid: 1,
					status: 'running',
				});
				ctx.emit('session:status', { id: 'a', status: 'running' });
				ctx.emit('session:status', { id: 'a', status: 'idle' });
				ctx.emit('session:close', { id: 'a' });
			}),
		],
		processes: { info: async () => ({ alive: true }), watch: () => 'unsupported' },
	});
	const events = collect(aya);
	await aya.start();
	assert.ok(events[0]?.startsWith('session:create:a'));
	assert.equal(events.filter((e) => e.startsWith('session:status:a:running')).length, 1);
	assert.ok(events.some((e) => e.startsWith('session:status:a:idle')));
	const close = events.find((e) => e.startsWith('session:close:a'));
	assert.ok(close);
	assert.equal(close?.endsWith(':'), true);
	assert.deepEqual(
		aya.running().map((s) => s.id),
		[],
	);
	const got = await aya.get('a');
	assert.equal(got?.id, 'a');
	assert.equal(got?.pid, undefined);
	await aya.stop();
});

test('a background wait keeps waitingFor until the session is running or idle again', async () => {
	let emit: WatchContext['emit'] | undefined;
	const aya = AllYourAgents({
		providers: [
			scripted((ctx) => {
				emit = ctx.emit;
				ctx.emit('session:create', { id: 'a', harness: 'Memory', provider: 'mem', pid: 1 });
				ctx.emit('session:status', { id: 'a', status: 'waiting', waitingFor: 'shell' });
			}),
		],
		processes: { info: async () => ({ alive: true }), watch: () => 'unsupported' },
	});
	const seen: string[] = [];
	aya.on('session:status', (s) => seen.push(`${s.status}:${s.waitingFor ?? ''}`));
	await aya.start();
	assert.equal(aya.running()[0]?.waitingFor, 'shell');
	assert.equal((await aya.get('a'))?.waitingFor, 'shell');
	assert.equal((await aya.sessions({ live: true }))[0]?.waitingFor, 'shell');
	// The same wait reported again is not a change; a wait on the user is.
	emit?.('session:status', { id: 'a', status: 'waiting', waitingFor: 'shell' });
	emit?.('session:status', { id: 'a', status: 'waiting', waitingFor: 'approve Bash' });
	emit?.('session:status', { id: 'a', status: 'waiting', waitingFor: 'shell' });
	emit?.('session:status', { id: 'a', status: 'idle' });
	assert.deepEqual(seen, ['waiting:shell', 'waiting:approve Bash', 'waiting:shell', 'idle:']);
	assert.equal('waitingFor' in (aya.running()[0] ?? {}), false);
	assert.equal('waitingFor' in ((await aya.get('a')) ?? {}), false);
	await aya.stop();
});

test('start is idempotent, ready once, catchUp then live', async () => {
	let watches = 0;
	const aya = AllYourAgents({
		providers: [
			scripted((ctx) => {
				watches++;
				ctx.emit('session:open', { id: 'a', harness: 'Memory', provider: 'mem', pid: 2 });
			}),
		],
		processes: { info: async () => ({ alive: true }), watch: () => 'unsupported' },
	});
	const catchUps: boolean[] = [];
	aya.on('session:open', (_s, meta) => catchUps.push(meta.catchUp));
	let ready = 0;
	aya.on('ready', () => ready++);
	await aya.start();
	await aya.start();
	assert.equal(watches, 1);
	assert.equal(ready, 1);
	assert.deepEqual(catchUps, [true]);
	await aya.stop();
});

test('no sessions → ready with nothing before it', async () => {
	const aya = AllYourAgents({
		providers: [scripted(() => {})],
		processes: { info: async () => ({ alive: true }), watch: () => 'unsupported' },
	});
	const events: string[] = [];
	aya.on('session:create', () => events.push('create'));
	aya.on('ready', () => events.push('ready'));
	await aya.start();
	assert.deepEqual(events, ['ready']);
	await aya.stop();
});

test('stop releases and further emits are dropped', async () => {
	let ctx: WatchContext | undefined;
	const aya = AllYourAgents({
		providers: [
			scripted((c) => {
				ctx = c;
			}),
		],
		processes: { info: async () => ({ alive: true }), watch: () => 'unsupported' },
	});
	let closed = 0;
	aya.on('session:create', () => closed++);
	await aya.start();
	await aya.stop();
	ctx?.emit('session:create', { id: 'z', harness: 'Memory', provider: 'mem' });
	assert.equal(closed, 0);
	assert.deepEqual(aya.running(), []);
});

test('reconcile: dead pid closes, live pid emits nothing', async () => {
	const alive = new Map<number, boolean>([
		[1, true],
		[2, false],
	]);
	const aya = AllYourAgents({
		providers: [
			{
				id: 'mem',
				harness: 'Memory',
				watch(ctx) {
					ctx.emit('session:create', { id: 'live', harness: 'Memory', provider: 'mem', pid: 1 });
					ctx.emit('session:create', { id: 'dead', harness: 'Memory', provider: 'mem', pid: 2 });
					return () => {};
				},
				async revalidate(ctx, pid) {
					for (const session of [
						{ id: 'live', pid: 1 },
						{ id: 'dead', pid: 2 },
					]) {
						if (pid != null && session.pid !== pid) continue;
						if (!alive.get(session.pid)) ctx.emit('session:close', { id: session.id });
					}
				},
			},
		],
		processes: {
			info: async (pid) => ({ alive: alive.get(pid) === true }),
			watch: () => 'unsupported',
		},
	});
	const closes: string[] = [];
	aya.on('session:close', (s) => closes.push(s.id));
	await aya.start();
	await aya.reconcile(1);
	assert.deepEqual(closes, []);
	await aya.reconcile(2);
	assert.deepEqual(closes, ['dead']);
	await aya.stop();
});

test('title precedence table', async () => {
	const aya = AllYourAgents({
		providers: [
			scripted((ctx) => {
				ctx.emit('session:create', { id: 't', harness: 'Memory', provider: 'mem' });
				ctx.emit('title', { id: 't', title: 'prompt', source: 'prompt' });
				ctx.emit('title', { id: 't', title: 'process', source: 'process' });
				ctx.emit('title', { id: 't', title: 'harness', source: 'harness' });
				ctx.emit('title', { id: 't', title: 'user', source: 'user' });
				ctx.emit('title', { id: 't', title: 'harness2', source: 'harness' });
				ctx.emit('title', { id: 't', title: 'prompt2', source: 'prompt' });
			}),
		],
		processes: { info: async () => ({ alive: true }), watch: () => 'unsupported' },
	});
	const titles: string[] = [];
	aya.on('session:update', (s) => titles.push(s.title ?? ''));
	await aya.start();
	assert.deepEqual(titles, ['prompt', 'process', 'harness', 'user']);
	assert.equal(aya.running()[0]?.title, 'user');
	await aya.stop();
});

test('provider failure isolation', async () => {
	const aya = AllYourAgents({
		providers: [
			{
				id: 'bad',
				harness: 'Bad',
				watch() {
					throw new Error('boom');
				},
			},
			scripted((ctx) => {
				ctx.emit('session:create', { id: 'ok', harness: 'Memory', provider: 'mem' });
			}),
		],
		processes: { info: async () => ({ alive: true }), watch: () => 'unsupported' },
	});
	const events: string[] = [];
	aya.on('error', (e) =>
		events.push(`error:${e.source === 'provider' ? e.provider : `listener:${e.event}`}`),
	);
	aya.on('session:create', (s) => events.push(`create:${s.id}`));
	aya.on('ready', () => events.push('ready'));
	await aya.start();
	assert.ok(events.includes('error:bad'));
	assert.ok(events.includes('create:ok'));
	assert.ok(events.includes('ready'));
	await aya.stop();
});

test('sessions() filters and works without start', async () => {
	const listed = [
		{
			id: 'old',
			harness: 'Memory' as const,
			provider: 'mem',
			cwd: '/a',
			kind: 'headless' as const,
			startedAt: 1,
			updatedAt: 10,
		},
		{
			id: 'new',
			harness: 'Memory' as const,
			provider: 'mem',
			cwd: '/b',
			kind: 'interactive' as const,
			startedAt: 20,
			updatedAt: 30,
		},
	];
	const provider: Provider = {
		id: 'mem',
		harness: 'Memory',
		watch() {
			return () => {};
		},
		async *list(ctx) {
			for (const row of listed) {
				if (ctx.id && row.id !== ctx.id) continue;
				yield row;
			}
		},
	};
	const aya = AllYourAgents({
		providers: [provider],
		processes: { info: async () => ({ alive: true }), watch: () => 'unsupported' },
	});
	const all = await aya.sessions();
	assert.deepEqual(all.map((s) => s.id).sort(), ['new', 'old']);
	const since = await aya.sessions({ since: 15 });
	assert.deepEqual(
		since.map((s) => s.id),
		['new'],
	);
	const kind = await aya.sessions({ kind: 'headless' });
	assert.deepEqual(
		kind.map((s) => s.id),
		['old'],
	);
	const cwd = await aya.sessions({ cwd: '/b' });
	assert.deepEqual(
		cwd.map((s) => s.id),
		['new'],
	);
	assert.equal((await aya.get('missing'))?.id, undefined);
	assert.equal((await aya.get('old'))?.id, 'old');
});

test('fake fs receives provider reads', async () => {
	const reads: string[] = [];
	const aya = AllYourAgents({
		providers: [
			{
				id: 'mem',
				harness: 'Memory',
				async watch(ctx) {
					await ctx.fs.readFile('/virtual/session.json').catch(() => new Uint8Array());
					return () => {};
				},
			},
		],
		fs: {
			async readFile(path) {
				reads.push(path);
				return new Uint8Array();
			},
			async readRange() {
				return new Uint8Array();
			},
			async readDir() {
				return [];
			},
			async stat() {
				return null;
			},
			watch() {
				return {
					close() {},
					async *[Symbol.asyncIterator]() {},
				};
			},
		},
		processes: { info: async () => ({ alive: true }), watch: () => 'unsupported' },
	});
	await aya.start();
	assert.deepEqual(reads, ['/virtual/session.json']);
	await aya.stop();
});

test('transcript groups two prompts into two completed turns', async () => {
	const journal: SessionEvent[] = [
		{ kind: 'user', text: 'one', raw: {} },
		{ kind: 'assistant', text: 'a', raw: {} },
		{ kind: 'turn-end', raw: {} },
		{ kind: 'user', text: 'two', raw: {} },
		{ kind: 'assistant', text: 'b', raw: {} },
		{ kind: 'turn-end', raw: {} },
	];
	const aya = AllYourAgents({
		providers: [
			{
				id: 'mem',
				harness: 'Memory',
				watch(ctx) {
					ctx.emit('session:create', { id: 's', harness: 'Memory', provider: 'mem' });
					return () => {};
				},
				async *inspect(_ctx, id) {
					if (id === 's') yield* journal;
				},
			},
		],
		processes: { info: async () => ({ alive: true }), watch: () => 'unsupported' },
	});
	await aya.start();
	const session = aya.running()[0];
	assert.ok(session);
	const turns = [];
	for await (const turn of session.transcript()) turns.push(turn);
	assert.equal(turns.length, 2);
	assert.equal(turns[0]?.outcome, 'completed');
	assert.equal(turns[1]?.outcome, 'completed');
	await aya.stop();
});
