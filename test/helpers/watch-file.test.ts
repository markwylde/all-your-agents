import assert from 'node:assert/strict';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLocalFs } from '../../src/helpers/fs.js';
import { watchFile } from '../../src/helpers/watch-file.js';
import { waitFor } from '../util/wait.js';

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
