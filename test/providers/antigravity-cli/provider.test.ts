import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FakeClock } from '../../../src/helpers/clock.js';
import { createLocalFs } from '../../../src/helpers/fs.js';
import type {
	Clock,
	Processes,
	Sqlite,
	SqliteRow,
	WatchHandle,
} from '../../../src/helpers/types.js';
import { AllYourAgents, antigravityCli } from '../../../src/index.js';
import { databaseOf, lockOf, summariesOf } from '../../../src/providers/antigravity-cli/data.js';
import { sleep, waitFor } from '../../util/wait.js';
import { A, assistant, B, summary, user } from './fixtures.js';

async function fixture(clock?: Clock) {
	const home = await mkdtemp(join(tmpdir(), 'aya-agy-'));
	await mkdir(join(home, 'conversations'));
	await mkdir(join(home, 'presence'));
	await writeFile(summariesOf(home), 'fixture');
	const rows = new Map<string, SqliteRow[]>([[A, [user(), assistant()]]]);
	const catalog = new Map<string, SqliteRow>([[A, summary()]]);
	const owners = new Map<string, number[]>();
	const living = new Set<number>([10001, 10002]);
	const exits = new Map<number, () => void>();
	const queries: string[] = [];
	const sqlite: Sqlite = {
		async query(path, sql, params = []) {
			queries.push(`${path}:${sql}`);
			if (path === summariesOf(home))
				return [...catalog.values()].filter(
					(r) => !params.length || r.conversation_id === params[0],
				);
			const id = path.split('/').at(-1)?.slice(0, -3) ?? '';
			const list = rows.get(id) ?? [];
			return sql.includes('DESC')
				? list.slice(-1)
				: list.filter((r) => Number(r.idx) > Number(params[0] ?? -1)).slice(0, 256);
		},
	};
	const processes: Processes = {
		info: async (pid) => ({ alive: living.has(pid), startTime: 1000 + pid }),
		holders: async (path) => owners.get(path) ?? [],
		watch(pid, cb) {
			exits.set(pid, cb);
			return {
				stop() {
					exits.delete(pid);
				},
			};
		},
	};
	async function add(id = A, pid = 10001) {
		await writeFile(databaseOf(home, id), 'fixture');
		owners.set(lockOf(home, id), [pid]);
		await writeFile(lockOf(home, id), '');
	}
	const inner = createLocalFs();
	const watches = new Set<WatchHandle>();
	const fs = {
		...inner,
		watch(path: string) {
			const handle = inner.watch(path);
			watches.add(handle);
			return {
				[Symbol.asyncIterator]: () => handle[Symbol.asyncIterator](),
				close() {
					watches.delete(handle);
					handle.close();
				},
			};
		},
	};
	const aya = AllYourAgents({
		providers: [antigravityCli({ home })],
		fs,
		sqlite,
		processes,
		debounce: { quietMs: 5, maxLatencyMs: 30, clock },
	});
	const errors: unknown[] = [];
	aya.on('error', (e) => errors.push(e));
	return {
		home,
		watches,
		fs,
		rows,
		catalog,
		owners,
		living,
		exits,
		queries,
		sqlite,
		processes,
		add,
		aya,
		errors,
		async cleanup() {
			await aya.stop();
			await rm(home, { recursive: true, force: true });
		},
	};
}

test('catch-up validates locks, replays activity, follows status and closes/reopens', async () => {
	const f = await fixture();
	const events: string[] = [];
	f.aya.on('session:open', (s) => events.push(`open:${s.id}`));
	f.aya.on('session:close', (s) => events.push(`close:${s.id}`));
	try {
		await f.add();
		await f.aya.start();
		const session = f.aya.running()[0];
		assert.equal(session?.harness, 'AntiGravity');
		assert.equal(session?.pid, 10001);
		assert.equal(session?.title, 'Fixture title');
		assert.equal(session?.activity.lastTurn, 'completed');
		assert.equal(session?.status, 'idle');
		f.catalog.set(A, { ...summary(), status: 'CASCADE_RUN_STATUS_RUNNING' });
		f.rows.set(A, [user(), assistant(), assistant(2, 10, 9)]);
		await writeFile(`${databaseOf(f.home, A)}-wal`, 'change');
		await waitFor(() => f.aya.running()[0]?.status === 'waiting');
		f.catalog.set(A, summary());
		await writeFile(summariesOf(f.home), 'updated');
		await waitFor(() => f.aya.running()[0]?.status === 'idle');
		f.living.delete(10001);
		f.exits.get(10001)?.();
		assert.equal(f.aya.running().length, 0);
		f.owners.set(lockOf(f.home, A), [10002]);
		await writeFile(lockOf(f.home, A), 'resumed');
		await waitFor(() => f.aya.running()[0]?.pid === 10002);
		assert.deepEqual(events, [`open:${A}`, `close:${A}`, `open:${A}`]);
		assert.equal(f.errors.length, 0);
	} finally {
		await f.cleanup();
	}
});

test('stale, ambiguous and child locks stay out; new roots create and reconcile is targeted', async () => {
	const f = await fixture();
	let created = 0;
	f.aya.on('session:create', () => created++);
	try {
		await f.add();
		f.owners.set(lockOf(f.home, A), []);
		await f.aya.start();
		assert.equal(f.aya.running().length, 0);
		f.owners.set(lockOf(f.home, A), [10001, 10002]);
		await f.aya.reconcile();
		assert.equal(f.aya.running().length, 0);
		f.owners.set(lockOf(f.home, A), [10001]);
		await f.aya.reconcile();
		f.catalog.set(B, { ...summary(B), parent_conversation_id: A });
		f.rows.set(B, [user()]);
		await f.add(B, 10002);
		await sleep(80);
		assert.equal(f.aya.running().length, 1);
		f.catalog.set(B, summary(B));
		await writeFile(lockOf(f.home, B), 'root');
		await waitFor(() => f.aya.running().length === 2);
		assert.equal(created, 1);
		f.queries.length = 0;
		await f.aya.reconcile(10001);
		assert.equal(
			f.queries.some((q) => q.includes(`${B}.db`)),
			false,
		);
		f.owners.set(lockOf(f.home, A), []);
		await f.aya.reconcile(10001);
		assert.equal(f.aya.running().length, 1);
	} finally {
		await f.cleanup();
	}
});

test('history filters, no-reader/no-probe fallback and invalid identifiers', async () => {
	const f = await fixture();
	try {
		await f.add();
		const history = await f.aya.sessions();
		assert.equal(history.length, 1);
		assert.equal((await f.aya.sessions({ since: Date.parse('2028-01-01') })).length, 0);
		assert.equal(await f.aya.get('../invalid'), undefined);
		const none = AllYourAgents({ providers: [antigravityCli({ home: f.home })], sqlite: false });
		await none.start();
		assert.deepEqual(none.running(), []);
		assert.deepEqual(await none.sessions(), []);
		await none.stop();
		const noProbe = AllYourAgents({
			providers: [antigravityCli({ home: f.home })],
			sqlite: f.sqlite,
			processes: { info: f.processes.info, watch: () => 'unsupported' },
		});
		await noProbe.start();
		assert.equal(noProbe.running().length, 0);
		assert.equal((await noProbe.sessions()).length, 1);
		await noProbe.stop();
	} finally {
		await f.cleanup();
	}
});

test('following waits for finalized rows in order, ignores terminal edits and aborts idle', async () => {
	const f = await fixture();
	try {
		await f.add();
		f.rows.set(A, [user(), assistant(1, 2, 2), user(2)]);
		const session = await f.aya.get(A);
		assert.ok(session);
		const stream = session.events();
		const iterator = stream[Symbol.asyncIterator]();
		assert.equal((await iterator.next()).value?.kind, 'user');
		let resolved = false;
		const next = iterator.next().then((v) => {
			resolved = true;
			return v;
		});
		await sleep(60);
		assert.equal(resolved, false);
		f.rows.set(A, [user(), assistant(), user(2)]);
		await writeFile(`${databaseOf(f.home, A)}-wal`, 'done');
		assert.equal((await next).value?.kind, 'assistant');
		assert.equal((await iterator.next()).value?.kind, 'turn-end');
		assert.equal((await iterator.next()).value?.kind, 'user');
		const pending = iterator.next();
		stream.close();
		assert.equal((await pending).done, true);
	} finally {
		await f.cleanup();
	}
});

test('database replacement closes old binding; unsupported process watch reconciles exits', async () => {
	const f = await fixture();
	try {
		f.processes.watch = () => 'unsupported';
		await f.add();
		await f.aya.start();
		await writeFile(`${databaseOf(f.home, A)}.new`, 'replacement');
		await rename(`${databaseOf(f.home, A)}.new`, databaseOf(f.home, A));
		await f.aya.reconcile();
		await f.aya.reconcile();
		assert.equal(f.aya.running().length, 1);
		f.living.delete(10001);
		await f.aya.reconcile(10001);
		assert.equal(f.aya.running().length, 0);
	} finally {
		await f.cleanup();
	}
});

test('storage created after start is discovered and reused providers keep instances isolated', async () => {
	const f = await fixture();
	const provider = antigravityCli({ home: f.home });
	const first = AllYourAgents({ providers: [provider], sqlite: f.sqlite, processes: f.processes });
	const second = AllYourAgents({ providers: [provider], sqlite: f.sqlite, processes: f.processes });
	first.on('error', () => {});
	second.on('error', () => {});
	try {
		await first.start();
		await second.start();
		await f.add();
		await waitFor(() => first.running().length === 1 && second.running().length === 1);
		await first.stop();
		f.owners.set(lockOf(f.home, A), []);
		await second.reconcile(10001);
		assert.equal(second.running().length, 0);
	} finally {
		await first.stop();
		await second.stop();
		await f.cleanup();
	}
});

test('an asynchronous read error reports once and retries without dropping finalized events', async () => {
	const f = await fixture();
	try {
		await f.add();
		f.rows.set(A, [user()]);
		await f.aya.start();
		const original = f.sqlite.query;
		let fail = true;
		f.sqlite.query = async (path, sql, params) => {
			if (path === databaseOf(f.home, A) && sql.includes('DESC') && fail) {
				fail = false;
				throw new Error('transient fixture failure');
			}
			return original(path, sql, params);
		};
		f.rows.set(A, [user(), assistant()]);
		await f.aya.reconcile();
		assert.equal(f.errors.length, 1);
		await f.aya.reconcile();
		assert.equal(f.aya.running()[0]?.activity.lastTurn, 'completed');
	} finally {
		await f.cleanup();
	}
});

test('process exit during an awaited read invalidates that binding immediately', async () => {
	const f = await fixture();
	let release: (() => void) | undefined;
	try {
		await f.add();
		f.rows.set(A, [user()]);
		await f.aya.start();
		const original = f.sqlite.query;
		let blocked = false;
		f.sqlite.query = async (path, sql, params) => {
			if (path === databaseOf(f.home, A) && !blocked) {
				blocked = true;
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			}
			return original(path, sql, params);
		};
		const reconcile = f.aya.reconcile(10001);
		await waitFor(() => blocked);
		f.living.delete(10001);
		f.exits.get(10001)?.();
		assert.equal(f.aya.running().length, 0);
		release?.();
		await reconcile;
		assert.equal(f.aya.running().length, 0);
		assert.equal(f.errors.length, 0);
	} finally {
		release?.();
		await f.cleanup();
	}
});

test('inspect aborts when the database is replaced and skips malformed finalized rows', async () => {
	const f = await fixture();
	try {
		await f.add();
		f.rows.set(A, [{ ...user(), step_payload: new Uint8Array([10, 99]) }, user(1)]);
		const session = await f.aya.get(A);
		assert.ok(session);
		const stream = session.events(),
			iterator = stream[Symbol.asyncIterator]();
		assert.equal((await iterator.next()).value?.kind, 'user');
		const pending = iterator.next();
		await writeFile(`${databaseOf(f.home, A)}.new`, 'new');
		await rename(`${databaseOf(f.home, A)}.new`, databaseOf(f.home, A));
		assert.equal((await pending).done, true);
		stream.close();
	} finally {
		await f.cleanup();
	}
});

test('stop during queued I/O releases every watch and prevents later emissions', async () => {
	const f = await fixture();
	let release: (() => void) | undefined;
	try {
		await f.add();
		await f.aya.start();
		assert.ok(f.watches.size > 0);
		const original = f.sqlite.query;
		let blocked = false;
		let afterStop = 0;
		f.sqlite.query = async (path, sql, params) => {
			if (path === databaseOf(f.home, A) && !blocked) {
				blocked = true;
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			}
			return original(path, sql, params);
		};
		const queued = f.aya.reconcile(10001);
		await waitFor(() => blocked);
		await f.aya.stop();
		assert.equal(f.watches.size, 0);
		f.aya.on('session:open', () => afterStop++);
		f.aya.on('session:activity', () => afterStop++);
		release?.();
		await queued;
		assert.equal(afterStop, 0);
		assert.equal(f.watches.size, 0);
	} finally {
		release?.();
		await f.cleanup();
	}
});

test('a wholly absent home can appear later', async () => {
	const f = await fixture();
	try {
		await rm(f.home, { recursive: true, force: true });
		await f.aya.start();
		await mkdir(join(f.home, 'presence'), { recursive: true });
		await mkdir(join(f.home, 'conversations'));
		await writeFile(summariesOf(f.home), 'fixture');
		await f.add();
		await waitFor(() => f.aya.running().length === 1);
	} finally {
		await f.cleanup();
	}
});

test('idle observation arms no timers and does no scheduled reads', async () => {
	const clock = new FakeClock(),
		f = await fixture(clock);
	try {
		await f.add();
		await f.aya.start();
		for (let i = 0; i < 5; i++) {
			clock.advance(100);
			await sleep(20);
		}
		assert.equal(clock.pending(), 0);
		const before = f.queries.length;
		clock.advance(60_000);
		await sleep(20);
		assert.equal(clock.pending(), 0);
		assert.equal(f.queries.length, before);
	} finally {
		await f.cleanup();
	}
});

test('injected remote processes may share the local observer PID', async () => {
	const f = await fixture();
	try {
		f.living.add(process.pid);
		await f.add(A, process.pid);
		await f.aya.start();
		assert.equal(f.aya.running()[0]?.pid, process.pid);
	} finally {
		await f.cleanup();
	}
});

test('watch-before-scan catches conversations created during the initial scan exactly once', async () => {
	const f = await fixture();
	let injected = false;
	const ids: string[] = [];
	f.aya.on('session:open', (s) => ids.push(s.id));
	f.aya.on('session:create', (s) => ids.push(s.id));
	try {
		await f.add();
		const readDir = f.fs.readDir.bind(f.fs);
		f.fs.readDir = async (path) => {
			if (path === join(f.home, 'conversations') && !injected) {
				injected = true;
				f.catalog.set(B, summary(B));
				f.rows.set(B, [user()]);
				await f.add(B, 10002);
			}
			return readDir(path);
		};
		await f.aya.start();
		assert.equal(f.aya.running().length, 2);
		assert.deepEqual(ids.sort(), [A, B]);
	} finally {
		await f.cleanup();
	}
});

test('a synchronous process-exit callback cannot attach orphaned binding watches', async () => {
	const f = await fixture();
	let stopped = 0;
	try {
		await f.add();
		f.processes.watch = (_pid, onExit) => {
			onExit();
			return {
				stop() {
					stopped++;
				},
			};
		};
		await f.aya.start();
		assert.equal(f.aya.running().length, 0);
		assert.ok(stopped > 0);
		await f.aya.stop();
		assert.equal(f.watches.size, 0);
	} finally {
		await f.cleanup();
	}
});
