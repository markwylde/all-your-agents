import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLocalFs } from '../../src/helpers/fs.js';
import { watchFile } from '../../src/helpers/watch-file.js';
import { sleep, waitFor } from '../util/wait.js';

test('watchFile reports change and delete', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'aya-file-'));
	const path = join(dir, 'f.json');
	await writeFile(path, '{}');
	try {
		const fs = createLocalFs();
		const events: string[] = [];
		const w = watchFile(fs, path, (e) => events.push(e.type), { quietMs: 15 });
		await writeFile(path, '{"a":1}');
		await waitFor(() => events.includes('change'));
		await unlink(path);
		await waitFor(() => events.includes('delete'));
		w.close();
		assert.ok(events.includes('change'));
		assert.ok(events.includes('delete'));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('watchFile keeps reporting tmp-then-rename rewrites and ignores siblings', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'aya-file-'));
	const path = join(dir, 'index.json');
	await writeFile(path, '[]');
	try {
		const fs = createLocalFs();
		let changes = 0;
		const w = watchFile(
			fs,
			path,
			(e) => {
				if (e.type === 'change') changes++;
			},
			{ quietMs: 15 },
		);
		await sleep(50);
		await writeFile(join(dir, 'index.json.tmp'), '[1]');
		await rename(join(dir, 'index.json.tmp'), path);
		await waitFor(() => changes >= 1);
		const afterFirst = changes;
		await writeFile(join(dir, 'index.json.tmp'), '[1,2]');
		await rename(join(dir, 'index.json.tmp'), path);
		await waitFor(() => changes > afterFirst);
		const afterSecond = changes;
		await writeFile(join(dir, 'other.json'), '{}');
		await sleep(100);
		assert.equal(changes, afterSecond, 'a sibling write is not a change');
		w.close();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('watchFile waits for a missing parent and reports the file once created', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'aya-file-'));
	const path = join(dir, 'home', 'deeper', 'index.json');
	try {
		const fs = createLocalFs();
		const events: string[] = [];
		const w = watchFile(fs, path, (e) => events.push(e.type), { quietMs: 15 });
		await sleep(50);
		await mkdir(join(dir, 'home', 'deeper'), { recursive: true });
		await writeFile(path, '[]');
		await waitFor(() => events.includes('change'));
		await writeFile(join(dir, 'home', 'deeper', 'tmp'), '[1]');
		await rename(join(dir, 'home', 'deeper', 'tmp'), path);
		await waitFor(() => events.filter((e) => e === 'change').length >= 2);
		w.close();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
