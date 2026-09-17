import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { FakeClock } from '../../src/helpers/clock.js';
import { createLocalFs } from '../../src/helpers/fs.js';
import { tailJsonl } from '../../src/helpers/tail-jsonl.js';
import type { Fs, FsWatchEvent } from '../../src/helpers/types.js';
import { watchDir } from '../../src/helpers/watch-dir.js';
import { watchFile } from '../../src/helpers/watch-file.js';
import { sleep, waitFor } from '../util/wait.js';

/**
 * An in-memory filesystem whose watches never deliver anything unless the test says so,
 * and which announces watch churn as the contract requires. What a helper reports here
 * without a notification, it found by catching up.
 */
function silentFs() {
	const files = new Map<string, { bytes: Uint8Array; mtimeMs: number }>();
	const dirs = new Set<string>();
	const listeners = new Set<() => void>();
	const watches = new Map<object, { path: string; deliver(e: FsWatchEvent): void }>();
	const calls = { stat: [] as string[], readDir: 0, readRange: 0 };
	let tick = 1;
	const churn = (): void => {
		for (const l of [...listeners]) l();
	};
	const fs: Fs = {
		readFile: async (path) => files.get(path)?.bytes ?? new Uint8Array(),
		async readRange(path, start, end) {
			calls.readRange++;
			return (files.get(path)?.bytes ?? new Uint8Array()).slice(start, end);
		},
		async readDir(path) {
			calls.readDir++;
			if (!dirs.has(path)) throw new Error('ENOENT');
			return [...files.keys()]
				.filter((f) => dirname(f) === path)
				.map((f) => f.slice(path.length + 1));
		},
		async stat(path) {
			calls.stat.push(path);
			if (dirs.has(path)) return { size: 0, mtimeMs: 0, isFile: false, isDirectory: true };
			const f = files.get(path);
			return f
				? { size: f.bytes.byteLength, mtimeMs: f.mtimeMs, isFile: true, isDirectory: false }
				: null;
		},
		watch(path) {
			const pending: FsWatchEvent[] = [];
			let wake: (() => void) | undefined;
			let closed = false;
			const handle = {
				close() {
					if (closed) return;
					closed = true;
					watches.delete(handle);
					wake?.();
					churn();
				},
				async *[Symbol.asyncIterator]() {
					while (!closed) {
						const next = pending.shift();
						if (next) yield next;
						else
							await new Promise<void>((resolve) => {
								wake = resolve;
							});
					}
				},
			};
			watches.set(handle, {
				path,
				deliver(e) {
					pending.push(e);
					wake?.();
				},
			});
			churn();
			return handle;
		},
		onWatchChurn(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	return {
		fs,
		calls,
		listeners,
		churn,
		mkdir: (path: string) => dirs.add(path),
		write(path: string, text: string) {
			files.set(path, { bytes: new TextEncoder().encode(text), mtimeMs: tick++ });
		},
		append(path: string, text: string) {
			const before = new TextDecoder().decode(files.get(path)?.bytes ?? new Uint8Array());
			this.write(path, before + text);
		},
		remove: (path: string) => files.delete(path),
		openWatches: () => [...watches.values()].map((w) => w.path),
	};
}

/** Let promise chains that the fake clock started run to completion. */
const drain = async (): Promise<void> => {
	for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

const DIR = '/home/sessions';

async function watchedDir() {
	const m = silentFs();
	const clock = new FakeClock();
	m.mkdir(DIR);
	m.write(join(DIR, '1.json'), 'one');
	m.write(join(DIR, '2.json'), 'two');
	const events: string[] = [];
	const w = watchDir(m.fs, DIR, (e) => events.push(`${e.type}:${e.name}`), { clock });
	await w.ready;
	// The watch's own open was churn. Let that pass run: nothing has changed.
	clock.advance(25);
	await drain();
	assert.deepEqual(events.sort(), ['create:1.json', 'create:2.json']);
	events.length = 0;
	return { m, clock, events, w };
}

test('watchDir: a rewrite whose notification was lost is reported after churn, and only it', async () => {
	const { m, clock, events, w } = await watchedDir();
	m.write(join(DIR, '2.json'), 'two, rewritten');
	await drain();
	assert.deepEqual(events, [], 'no notification, no churn: nothing yet');

	m.churn();
	assert.deepEqual(events, [], 'not during the churn');
	clock.advance(24);
	await drain();
	assert.deepEqual(events, []);
	clock.advance(1);
	await drain();
	assert.deepEqual(events, ['change:2.json']);
	assert.equal(clock.pending(), 0);

	m.churn();
	clock.advance(25);
	await drain();
	assert.deepEqual(events, ['change:2.json'], 'caught up once, not again');
	w.close();
});

test('watchDir: entries created and removed unseen are reported after churn', async () => {
	const { m, clock, events, w } = await watchedDir();
	m.write(join(DIR, '3.json'), 'three');
	m.remove(join(DIR, '1.json'));
	m.churn();
	clock.advance(25);
	await drain();
	assert.deepEqual(events.sort(), ['create:3.json', 'delete:1.json']);
	w.close();
});

test('watchDir: a burst of churn is one pass, unchanged entries are statted but not reported', async () => {
	const { m, clock, events, w } = await watchedDir();
	const before = { readDir: m.calls.readDir, stats: m.calls.stat.length };
	for (let i = 0; i < 10; i++) {
		m.churn();
		clock.advance(2);
	}
	clock.advance(25);
	await drain();
	assert.equal(m.calls.readDir - before.readDir, 1);
	assert.deepEqual(m.calls.stat.slice(before.stats).sort(), [
		join(DIR, '1.json'),
		join(DIR, '2.json'),
	]);
	assert.deepEqual(events, []);
	assert.equal(clock.pending(), 0, 'no timer remains once the pass has run');
	w.close();
});

test('watchDir: continuous churn is still serviced by the latency ceiling', async () => {
	const { m, clock, events, w } = await watchedDir();
	m.write(join(DIR, '1.json'), 'changed');
	for (let i = 0; i < 100; i++) {
		m.churn();
		clock.advance(20);
	}
	await drain();
	assert.deepEqual(events, ['change:1.json']);
	w.close();
});

test('watchDir: a missing directory created unseen is picked up after churn', async () => {
	const m = silentFs();
	const clock = new FakeClock();
	m.mkdir('/home');
	const events: string[] = [];
	const w = watchDir(m.fs, DIR, (e) => events.push(`${e.type}:${e.name}`), { clock });
	await w.ready;
	assert.deepEqual(m.openWatches(), ['/home']);
	m.mkdir(DIR);
	m.write(join(DIR, '9.json'), 'nine');
	m.churn();
	clock.advance(25);
	await drain();
	assert.deepEqual(events, ['create:9.json']);
	assert.deepEqual(m.openWatches(), [DIR]);
	w.close();
});

test('a closed helper is unsubscribed and does nothing', async () => {
	const { m, clock, events, w } = await watchedDir();
	const file = watchFile(m.fs, join(DIR, '1.json'), () => events.push('file'), { clock });
	const tail = tailJsonl(m.fs, join(DIR, '2.json'), { clock });
	assert.equal(m.listeners.size, 3);
	w.close();
	file.close();
	tail.close();
	assert.equal(m.listeners.size, 0);
	assert.deepEqual(m.openWatches(), []);
	m.write(join(DIR, '1.json'), 'changed');
	m.churn();
	clock.advance(1000);
	await drain();
	assert.deepEqual(events, []);
	assert.equal(clock.pending(), 0);
});

test('watchFile: reports a difference after churn, and nothing when there is none', async () => {
	const m = silentFs();
	const clock = new FakeClock();
	m.mkdir(DIR);
	const path = join(DIR, '1.json');
	m.write(path, 'one');
	const events: string[] = [];
	const w = watchFile(m.fs, path, (e) => events.push(e.type), { clock });
	const pass = async () => {
		m.churn();
		clock.advance(25);
		await drain();
	};
	await pass();
	assert.deepEqual(events, [], 'unchanged');
	m.write(path, 'one, rewritten');
	await pass();
	assert.deepEqual(events, ['change']);
	await pass();
	assert.deepEqual(events, ['change']);
	m.remove(path);
	await pass();
	assert.deepEqual(events, ['change', 'delete']);
	await pass();
	assert.deepEqual(events, ['change', 'delete'], 'still absent');
	m.write(path, 'back');
	await pass();
	assert.deepEqual(events, ['change', 'delete', 'change']);
	w.close();
});

test('tailJsonl: an append whose notification was lost is yielded once after churn', async () => {
	const m = silentFs();
	const clock = new FakeClock();
	m.mkdir(DIR);
	const path = join(DIR, 'j.jsonl');
	m.write(path, '{"n":1}\n');
	const tail = tailJsonl(m.fs, path, { clock });
	const iter = tail[Symbol.asyncIterator]();
	assert.deepEqual((await iter.next()).value, { n: 1 });
	clock.advance(25);
	await drain();

	m.append(path, '{"n":2}\n{"n":3}\n');
	const next = iter.next();
	m.churn();
	clock.advance(25);
	assert.deepEqual((await next).value, { n: 2 });
	assert.deepEqual((await iter.next()).value, { n: 3 });

	const reads = m.calls.readRange;
	m.churn();
	clock.advance(25);
	await drain();
	assert.equal(m.calls.readRange, reads, 'nothing appended: a stat, no read');
	assert.equal(clock.pending(), 0);
	tail.close();
});

test('tailJsonl: churn during the first read is honoured when that read finishes', async () => {
	const m = silentFs();
	const clock = new FakeClock();
	m.mkdir(DIR);
	const path = join(DIR, 'j.jsonl');
	m.write(path, '{"n":1}\n');
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const readRange = m.fs.readRange;
	let first = true;
	m.fs.readRange = async (p, start, end) => {
		const bytes = await readRange(p, start, end);
		if (first) {
			first = false;
			// Appended after the first read took its bytes, with the catch-up already due.
			m.append(path, '{"n":2}\n');
			clock.advance(25);
			await held;
		}
		return bytes;
	};
	const tail = tailJsonl(m.fs, path, { clock });
	const iter = tail[Symbol.asyncIterator]();
	await drain();
	release();
	assert.deepEqual((await iter.next()).value, { n: 1 });
	assert.deepEqual((await iter.next()).value, { n: 2 });
	tail.close();
});

const macOnly = { skip: process.platform === 'darwin' ? false : 'FSEvents only' };

test('local filesystem: announces every watch open and close, process-wide', macOnly, async () => {
	const dir = await mkdtemp(join(tmpdir(), 'aya-churn-'));
	try {
		const a = createLocalFs();
		const b = createLocalFs();
		let seen = 0;
		const off = a.onWatchChurn?.(() => seen++);
		assert.ok(off, 'macOS local filesystem implements onWatchChurn');
		const handle = b.watch(dir);
		assert.equal(seen, 1, 'a watch opened through another instance is seen');
		handle.close();
		handle.close();
		assert.equal(seen, 2, 'closing counts once');
		off();
		b.watch(dir).close();
		assert.equal(seen, 2);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('local filesystem: no churn signal where watches do not disturb each other', {
	skip: process.platform === 'darwin' ? 'macOS has the defect' : false,
}, () => {
	assert.equal(createLocalFs().onWatchChurn, undefined);
});

test(
	'an established watch misses nothing while other watches open and close',
	macOnly,
	async () => {
		const root = await mkdtemp(join(tmpdir(), 'aya-churn-'));
		const watched = join(root, 'sessions');
		await mkdir(watched);
		const others: string[] = [];
		for (let i = 0; i < 5; i++) {
			others.push(join(root, `other-${i}`));
			await mkdir(others[i] ?? root);
		}
		const fs = createLocalFs();
		const seen = new Set<string>();
		const w = watchDir(fs, watched, (e) => seen.add(e.name), { quietMs: 25 });
		try {
			await w.ready;
			await sleep(300);
			const count = 200;
			for (let i = 0; i < count; i++) {
				const churn = fs.watch(others[i % 5] ?? root);
				await writeFile(join(watched, `f${i}`), 'x');
				churn.close();
				await sleep(5);
			}
			await waitFor(() => seen.size === count, 5000).catch(() => {});
			const missed = [];
			for (let i = 0; i < count; i++) if (!seen.has(`f${i}`)) missed.push(i);
			assert.deepEqual(missed, []);
		} finally {
			w.close();
			await rm(root, { recursive: true, force: true });
		}
	},
);
