import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLocalFs } from '../../src/helpers/fs.js';
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
		const after = stats.slice(before).filter((p) => p.endsWith('.json'));
		assert.deepEqual(after, [join(dir, '7.json')]);
		w.close();
	});
});

test('an entry created during the initial scan is reported exactly once', async () => {
	await withDir(async (dir) => {
		const fs = spyFs();
		await writeFile(join(dir, 'old.json'), '{}');
		// readDir has already listed the directory when this runs, so the scan cannot see it.
		fs.hooks.readDir = async () => {
			fs.hooks.readDir = undefined;
			await writeFile(join(dir, 'racing.json'), '{}');
		};
		const events: string[] = [];
		const w = watchDir(fs, dir, (e) => events.push(`${e.type}:${e.name}`), { quietMs: 15 });
		await waitFor(() => events.includes('create:racing.json'));
		await sleep(80);
		assert.deepEqual(events.filter((e) => e.startsWith('create:')).sort(), [
			'create:old.json',
			'create:racing.json',
		]);
		w.close();
	});
});

test('a watched directory that is removed and created again is watched again', async () => {
	await withDir(async (dir) => {
		const fs = spyFs();
		const sessions = join(dir, 'sessions');
		await mkdir(sessions);
		await writeFile(join(sessions, 'old.json'), '{}');
		const events: string[] = [];
		const w = watchDir(fs, sessions, (e) => events.push(`${e.type}:${e.name}`), { quietMs: 15 });
		await w.ready;
		assert.deepEqual(events, ['create:old.json']);
		await rm(sessions, { recursive: true });
		await waitFor(() => events.includes('delete:old.json'), 3000);
		await mkdir(sessions);
		await writeFile(join(sessions, 'new.json'), '{}');
		await waitFor(() => events.includes('create:new.json'), 3000);
		assert.deepEqual(events, ['create:old.json', 'delete:old.json', 'create:new.json']);
		w.close();
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
