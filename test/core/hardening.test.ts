import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AllYourAgents } from '../../src/index.js';
import type { Provider, WatchContext } from '../../src/provider.js';
import type { AgentsError, Session, SessionEvent } from '../../src/types.js';

const processes = { info: async () => ({ alive: true }), watch: () => 'unsupported' as const };

function scripted(
	run: (ctx: WatchContext) => void | Promise<void>,
	opts?: Partial<Provider>,
): Provider {
	return {
		id: 'mem',
		harness: 'Memory',
		watch(ctx) {
			return Promise.resolve(run(ctx)).then(() => () => {});
		},
		...opts,
	};
}

test('a throwing listener is reported and stops nothing', async () => {
	let ctx: WatchContext | undefined;
	const aya = AllYourAgents({
		providers: [
			scripted((c) => {
				ctx = c;
				c.emit('session:create', { id: 'a', harness: 'Memory', provider: 'mem', pid: 1 });
			}),
		],
		processes,
	});
	const errors: AgentsError[] = [];
	const seen: string[] = [];
	aya.on('error', (e) => errors.push(e));
	aya.on('session:activity', () => {
		throw new Error('listener bug');
	});
	aya.on('session:activity', (s) => seen.push(s.activity.tool?.name ?? '-'));
	await aya.start();

	// The provider's emit must return normally, or its tail loop would die.
	assert.doesNotThrow(() =>
		ctx?.emit('turn', { sessionId: 'a', type: 'tool-started', id: 't1', name: 'Bash' }),
	);
	ctx?.emit('turn', { sessionId: 'a', type: 'tool-finished', id: 't1' });

	assert.deepEqual(seen, ['Bash', '-']);
	assert.equal(errors.length, 2);
	const [first] = errors;
	assert.ok(first?.source === 'listener');
	assert.equal(first.event, 'session:activity');
	assert.equal((first.error as Error).message, 'listener bug');
	await aya.stop();
});

test('a listener failure with no error listener surfaces as an uncaught exception', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'aya-uncaught-'));
	try {
		const index = pathToFileURL(
			join(dirname(fileURLToPath(import.meta.url)), '../../src/index.js'),
		).href;
		const script = join(dir, 'run.mjs');
		await writeFile(
			script,
			`import { AllYourAgents } from ${JSON.stringify(index)};
const aya = AllYourAgents({
	providers: [{ id: 'mem', harness: 'Memory', watch(ctx) {
		ctx.emit('session:create', { id: 'a', harness: 'Memory', provider: 'mem' });
		console.log('emit returned');
		return () => {};
	} }],
	processes: { info: async () => ({ alive: true }), watch: () => 'unsupported' },
});
aya.on('session:create', () => { throw new Error('nobody is listening for this'); });
await aya.start();
`,
		);
		const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
			(resolve) => {
				const child = execFile(process.execPath, [script], (_error, stdout, stderr) =>
					resolve({ code: child.exitCode, stdout, stderr }),
				);
			},
		);
		assert.match(result.stdout, /emit returned/);
		assert.notEqual(result.code, 0);
		assert.match(result.stderr, /nobody is listening for this/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('reportError after watch() names the provider and the provider keeps working', async () => {
	let ctx: WatchContext | undefined;
	const aya = AllYourAgents({
		providers: [
			scripted(
				(c) => {
					ctx = c;
				},
				{ id: 'late' },
			),
		],
		processes,
	});
	const errors: AgentsError[] = [];
	const created: string[] = [];
	aya.on('error', (e) => errors.push(e));
	aya.on('session:create', (s) => created.push(s.id));
	await aya.start();
	ctx?.reportError(new Error('bad record'));
	ctx?.emit('session:create', { id: 'after', harness: 'Memory', provider: 'late' });
	assert.equal(errors.length, 1);
	assert.deepEqual(
		{ source: errors[0]?.source, provider: errors[0]?.source === 'provider' && errors[0].provider },
		{ source: 'provider', provider: 'late' },
	);
	assert.deepEqual(created, ['after']);
	await aya.stop();
});

function historian(id: string, sessionId: string, asked: string[]): Provider {
	return {
		id,
		harness: 'Memory',
		watch: () => () => {},
		async *list() {
			yield { id: sessionId, harness: 'Memory', provider: id };
		},
		async *inspect(_ctx, wanted): AsyncIterable<SessionEvent> {
			asked.push(`${id}:inspect:${wanted}`);
			yield { kind: 'user', text: `from ${id}`, raw: {} };
		},
		async subagents(_ctx, wanted) {
			asked.push(`${id}:subagents:${wanted}`);
			return [];
		},
	};
}

test('history is read through the owning provider, never the first one', async () => {
	const asked: string[] = [];
	const aya = AllYourAgents({
		providers: [historian('first', 's1', asked), historian('second', 's2', asked)],
		processes,
	});
	const session = (await aya.sessions()).find((s) => s.id === 's2');
	assert.equal(session?.provider, 'second');
	const texts: string[] = [];
	for await (const turn of session?.transcript() ?? []) {
		for (const event of turn.events) if (event.kind === 'user') texts.push(event.text);
	}
	await session?.subagents();
	assert.deepEqual(texts, ['from second']);
	assert.deepEqual(asked, ['second:inspect:s2', 'second:subagents:s2']);

	const viaGet = await aya.get('s2');
	for await (const _ of viaGet?.transcript() ?? []) {
		// drain
	}
	assert.deepEqual(asked.slice(2), ['second:inspect:s2']);
});

test('a provider without history yields nothing and no other provider is asked', async () => {
	const asked: string[] = [];
	let ctx: WatchContext | undefined;
	const aya = AllYourAgents({
		providers: [
			historian('first', 's1', asked),
			scripted(
				(c) => {
					ctx = c;
				},
				{ id: 'watch-only' },
			),
		],
		processes,
	});
	let live: Session | undefined;
	aya.on('session:create', (s) => {
		live = s;
	});
	await aya.start();
	ctx?.emit('session:create', { id: 'w', harness: 'Memory', provider: 'watch-only' });
	const turns = [];
	for await (const turn of live?.transcript() ?? []) turns.push(turn);
	assert.deepEqual(turns, []);
	assert.deepEqual(await live?.subagents(), []);
	assert.deepEqual(asked, []);
	await aya.stop();
});

test('a live session has the same shape from every source', async () => {
	let ctx: WatchContext | undefined;
	const aya = AllYourAgents({
		providers: [
			scripted(
				(c) => {
					ctx = c;
					c.emit('session:create', {
						id: 'a',
						harness: 'Memory',
						provider: 'mem',
						pid: 7,
						cwd: '/w',
						status: 'running',
					});
				},
				{
					async *list() {
						yield { id: 'a', harness: 'Memory', provider: 'mem', cwd: '/w', title: 'from disk' };
					},
				},
			),
		],
		processes,
	});
	let fromEvent: Session | undefined;
	aya.on('session:status', (s) => {
		fromEvent = s;
	});
	await aya.start();
	const data = (s: Session | undefined) =>
		JSON.stringify(s, (_key, v) => (typeof v === 'function' ? undefined : v));
	const keys = (s: Session | undefined) => Object.keys(s ?? {}).sort();
	const sources = [
		fromEvent,
		aya.running()[0],
		(await aya.sessions())[0],
		(await aya.sessions({ live: true }))[0],
		await aya.get('a'),
	];
	for (const s of sources) {
		assert.deepEqual(keys(s), keys(fromEvent));
		assert.equal(data(s), data(fromEvent));
		assert.equal(
			Object.values(s ?? {}).some((v) => v === undefined),
			false,
		);
	}
	assert.equal((await aya.sessions()).length, 1);

	const before = sources[2];
	ctx?.emit('turn', { sessionId: 'a', type: 'tool-started', id: 't', name: 'Bash' });
	assert.equal(before?.activity.tool, undefined, 'a returned session is a copy');
	await aya.stop();
});

test('stop then start catches up again, running subagents included', async () => {
	const aya = AllYourAgents({
		providers: [
			scripted((ctx) => {
				ctx.emit('session:create', { id: 'a', harness: 'Memory', provider: 'mem', pid: 1 });
				ctx.emit('subagent:start', {
					id: 'sub',
					sessionId: 'a',
					harness: 'Memory',
					type: 'Explore',
					background: true,
				});
			}),
		],
		processes,
	});
	const events: string[] = [];
	aya.on('session:create', (s, meta) => events.push(`create:${s.id}:${meta.catchUp}`));
	aya.on('subagent:start', (sub, _s, meta) => events.push(`sub:${sub.id}:${meta.catchUp}`));
	aya.on('ready', () => events.push('ready'));
	await aya.start();
	await aya.stop();
	await aya.start();
	const round = ['create:a:true', 'sub:sub:true', 'ready'];
	assert.deepEqual(events, [...round, ...round]);
	assert.equal(aya.running()[0]?.activity.openSubagents, 1);
	await aya.stop();
});

test('memory for closed sessions is bounded to the most recent 1000', async () => {
	let ctx: WatchContext | undefined;
	const aya = AllYourAgents({
		providers: [
			scripted((c) => {
				ctx = c;
			}),
		],
		processes,
	});
	await aya.start();
	for (let i = 0; i <= 1000; i++) {
		const id = `s${i}`;
		ctx?.emit('session:create', { id, harness: 'Memory', provider: 'mem', pid: i + 1 });
		ctx?.emit('session:close', { id });
	}
	assert.equal(await aya.get('s0'), undefined, 'the oldest was released');
	assert.equal((await aya.get('s1'))?.id, 's1');
	assert.equal((await aya.get('s1000'))?.id, 's1000');
	assert.equal((await aya.sessions()).length, 1000);

	// Re-opening and closing again makes a session the most recently closed.
	ctx?.emit('session:open', { id: 's1', harness: 'Memory', provider: 'mem', pid: 5000 });
	ctx?.emit('session:close', { id: 's1' });
	ctx?.emit('session:create', { id: 'extra', harness: 'Memory', provider: 'mem', pid: 5001 });
	ctx?.emit('session:close', { id: 'extra' });
	assert.equal((await aya.get('s1'))?.id, 's1');
	assert.equal(await aya.get('s2'), undefined);
	await aya.stop();
});
