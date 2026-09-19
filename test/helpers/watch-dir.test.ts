import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLocalFs } from '../../src/helpers/fs.js';
import type { Fs, FsWatchEvent } from '../../src/helpers/types.js';
import { watchDir } from '../../src/helpers/watch-dir.js';
import { spyFs } from '../util/spy-fs.js';
import { sleep, waitFor } from '../util/wait.js';

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), 'aya-watch-'));
	try {
		await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test('watchDir reports create', async () => {
	await withDir(async (dir) => {
		const fs = createLocalFs();
		const events: string[] = [];
		const w = watchDir(fs, dir, (e) => events.push(`${e.type}:${e.name}`), { quietMs: 15 });
		await sleep(30);
		await writeFile(join(dir, 'a.json'), '{}');
		await waitFor(() => events.includes('create:a.json'));
		w.close();
	});
});

test('watchDir reports atomic rename-over as change, not delete', async () => {
	await withDir(async (dir) => {
		const fs = createLocalFs();
		const target = join(dir, 'sess.json');
		await writeFile(target, '{"n":1}');
		const events: string[] = [];
		const w = watchDir(fs, dir, (e) => events.push(`${e.type}:${e.name}`), { quietMs: 15 });
		await waitFor(() => events.includes('create:sess.json'));
		events.length = 0;
		const tmp = join(dir, 'sess.json.tmp');
		await writeFile(tmp, '{"n":2}');
		await rename(tmp, target);
		await sleep(80);
		assert.equal(events.filter((e) => e === 'delete:sess.json').length, 0);
		assert.ok(events.some((e) => e.startsWith('change:sess.json') || e === 'delete:sess.json.tmp'));
		w.close();
	});
});

test('watchDir reports delete', async () => {
	await withDir(async (dir) => {
		const fs = createLocalFs();
		await writeFile(join(dir, 'gone.json'), '{}');
		const events: string[] = [];
		const w = watchDir(fs, dir, (e) => events.push(`${e.type}:${e.name}`), { quietMs: 15 });
		await waitFor(() => events.includes('create:gone.json'));
		await unlink(join(dir, 'gone.json'));
		await waitFor(() => events.includes('delete:gone.json'));
		w.close();
	});
});

test('watchDir sees a directory created later', async () => {
	await withDir(async (dir) => {
		const fs = createLocalFs();
		const nested = join(dir, 'sessions');
		const events: string[] = [];
		const w = watchDir(fs, nested, (e) => events.push(`${e.type}:${e.name}`), { quietMs: 15 });
		await sleep(40);
		await mkdir(nested);
		await writeFile(join(nested, '1.json'), '{}');
		await waitFor(() => events.includes('create:1.json'), 3000);
		w.close();
	});
});

test('a change to one of fifty entries reads only that entry', async () => {
	await withDir(async (dir) => {
		const inner = createLocalFs();
		const stats: string[] = [];
		const fs = {
			...inner,
			async stat(path: string) {
				stats.push(path);
				return inner.stat(path);
			},
		};
		for (let i = 0; i < 50; i++) {
			await writeFile(join(dir, `${i}.json`), '{}');
		}
		const w = watchDir(fs, dir, () => {}, { quietMs: 15 });
		await sleep(80);
		const before = stats.length;
		await writeFile(join(dir, '7.json'), '{"x":1}');
		await sleep(80);
		// Under load one write can arrive as two notifications, so 7.json may be read twice;
		// what matters is that none of the other 49 are read.
		const after = new Set(stats.slice(before).filter((p) => p.endsWith('.json')));
		assert.deepEqual([...after], [join(dir, '7.json')]);
		w.close();
	});
});

/**
 * One directory, scripted: the test decides what it holds and when a notification is
 * delivered, so the order of watch, scan and event does not depend on the platform.
 */
function scriptedDir(dir: string, names: string[]) {
	const entries = new Set(names);
	const calls: string[] = [];
	let deliver: ((event: FsWatchEvent) => void) | undefined;
	let onReadDir: (() => Promise<void> | void) | undefined;
	const file = { size: 0, mtimeMs: 0, isFile: true, isDirectory: false };
	const fs: Fs = {
		readFile: async () => new Uint8Array(),
		readRange: async () => new Uint8Array(),
		async stat(path) {
			if (path === dir) return { ...file, isFile: false, isDirectory: true };
			return entries.has(path.slice(dir.length + 1)) ? file : null;
		},
		async readDir() {
			calls.push('readDir');
			const listed = [...entries];
			await onReadDir?.();
			return listed;
		},
		watch() {
			calls.push('watch');
			const pending: FsWatchEvent[] = [];
			let wake: (() => void) | undefined;
			let closed = false;
			deliver = (event) => {
				pending.push(event);
				wake?.();
			};
			return {
				close() {
					closed = true;
					wake?.();
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
		},
	};
	return {
		fs,
		calls,
		create(name: string) {
			entries.add(name);
			deliver?.({ type: 'rename', filename: name });
		},
		duringReadDir(fn: () => Promise<void> | void) {
			onReadDir = fn;
		},
	};
}

test('the watch opens before the scan, so an entry created during the scan is reported once', async () => {
	const dir = '/scripted/sessions';
	const d = scriptedDir(dir, ['old.json']);
	// The listing has been taken when this runs: only the notification can report it.
	d.duringReadDir(() => d.create('racing.json'));
	const events: string[] = [];
	const w = watchDir(d.fs, dir, (e) => events.push(`${e.type}:${e.name}`), { quietMs: 5 });
	try {
		await waitFor(() => events.includes('create:racing.json'));
		await sleep(30);
		assert.deepEqual(d.calls.slice(0, 2), ['watch', 'readDir']);
		assert.deepEqual(events.sort(), ['create:old.json', 'create:racing.json']);
	} finally {
		w.close();
	}
});

test('an entry the notification reported first is not reported again by the scan', async () => {
	const dir = '/scripted/sessions';
	const d = scriptedDir(dir, []);
	const events: string[] = [];
	// Created and fully serviced while the listing is still in flight, and the listing sees it too.
	d.duringReadDir(async () => {
		d.create('a.json');
		await waitFor(() => events.includes('create:a.json'));
	});
	const fs: Fs = { ...d.fs, readDir: async (p) => [...(await d.fs.readDir(p)), 'a.json'] };
	const w = watchDir(fs, dir, (e) => events.push(`${e.type}:${e.name}`), { quietMs: 5 });
	try {
		await w.ready;
		await sleep(30);
		assert.deepEqual(events, ['create:a.json']);
	} finally {
		w.close();
	}
});

test('a watched directory that is removed and created again is watched again', async () => {
	await withDir(async (dir) => {
		const fs = spyFs();
		const sessions = join(dir, 'sessions');
		await mkdir(sessions);
		await writeFile(join(sessions, 'old.json'), '{}');
		const events: string[] = [];
		const w = watchDir(fs, sessions, (e) => events.push(`${e.type}:${e.name}`), { quietMs: 15 });
		try {
			await w.ready;
			assert.deepEqual(events, ['create:old.json']);
			await rm(sessions, { recursive: true });
			await waitFor(() => events.includes('delete:old.json'), 3000);
			// Re-armed on the parent, waiting for the directory to come back.
			await waitFor(() => fs.openWatches().includes(dir), 3000);
			await mkdir(sessions);
			await writeFile(join(sessions, 'new.json'), '{}');
			await waitFor(() => events.includes('create:new.json'), 3000);
			// A late `change` for a file that exists is allowed; creation and removal are exact.
			assert.deepEqual(
				events.filter((e) => !e.startsWith('change:')),
				['create:old.json', 'delete:old.json', 'create:new.json'],
			);
		} finally {
			w.close();
		}
		assert.deepEqual(fs.openWatches(), []);
	});
});

test('several missing levels: only the target directory is ever reported', async () => {
	await withDir(async (dir) => {
		const fs = spyFs();
		const home = join(dir, 'home');
		const sessions = join(home, 'sessions');
		const events: string[] = [];
		const w = watchDir(fs, sessions, (e) => events.push(`${e.type}:${e.path}`), { quietMs: 15 });
		try {
			await w.ready;
			assert.deepEqual(fs.openWatches(), [dir]);
			await mkdir(home);
			await writeFile(join(home, 'settings.json'), '{}');
			// Re-armed one level down: it now waits for `sessions` under `home`.
			await waitFor(() => fs.openWatches().includes(home), 3000);
			await sleep(80);
			await mkdir(sessions);
			await writeFile(join(sessions, '1.json'), '{}');
			await waitFor(() => events.length > 0, 3000);
			await sleep(80);
			assert.deepEqual(events, [`create:${join(sessions, '1.json')}`]);
			assert.deepEqual(fs.openWatches(), [sessions]);
		} finally {
			w.close();
		}
		assert.deepEqual(fs.openWatches(), []);
	});
});

test('close during the initial scan leaves no watch open', async () => {
	await withDir(async (dir) => {
		const fs = spyFs();
		await writeFile(join(dir, 'a.json'), '{}');
		const events: string[] = [];
		let w: ReturnType<typeof watchDir> | undefined;
		fs.hooks.stat = () => w?.close();
		w = watchDir(fs, dir, (e) => events.push(e.name), { quietMs: 15 });
		await w.ready;
		await sleep(40);
		assert.deepEqual(fs.openWatches(), []);
		assert.deepEqual(events, []);
	});
});

test('close while waiting for a missing directory leaves no watch open', async () => {
	await withDir(async (dir) => {
		const fs = spyFs();
		let w: ReturnType<typeof watchDir> | undefined;
		let stats = 0;
		// Close partway through the walk up to the nearest existing ancestor.
		fs.hooks.stat = () => {
			if (++stats === 2) w?.close();
		};
		w = watchDir(fs, join(dir, 'a', 'b', 'c'), () => {}, { quietMs: 15 });
		await w.ready;
		await sleep(40);
		assert.deepEqual(fs.openWatches(), []);
	});
});
