import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLocalFs } from '../../src/helpers/fs.js';
import { tailJsonl } from '../../src/helpers/tail-jsonl.js';
import { sleep } from '../util/wait.js';

test('tailJsonl yields complete lines, keeps partial, handles append during replay', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'aya-tail-'));
	const path = join(dir, 'j.jsonl');
	await writeFile(path, '{"n":1}\n{"n":2');
	try {
		const fs = createLocalFs();
		const tail = tailJsonl(fs, path, { quietMs: 15 });
		const got: unknown[] = [];
		const iter = tail[Symbol.asyncIterator]();
		const first = await iter.next();
		got.push(first.value);
		assert.deepEqual(first.value, { n: 1 });
		await appendFile(path, '}\n{"n":3}\n');
		const second = await iter.next();
		const third = await iter.next();
		got.push(second.value, third.value);
		assert.deepEqual(got, [{ n: 1 }, { n: 2 }, { n: 3 }]);
		await iter.return?.(undefined);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('tailJsonl resets on truncation', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'aya-tail-'));
	const path = join(dir, 'j.jsonl');
	await writeFile(path, '{"n":1}\n{"n":2}\n');
	try {
		const fs = createLocalFs();
		const tail = tailJsonl(fs, path, { quietMs: 15 });
		const iter = tail[Symbol.asyncIterator]();
		assert.deepEqual((await iter.next()).value, { n: 1 });
		assert.deepEqual((await iter.next()).value, { n: 2 });
		await writeFile(path, '{"n":9}\n');
		const next = await iter.next();
		assert.deepEqual(next.value, { n: 9 });
		await iter.return?.(undefined);
		void truncate;
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('break releases the watcher', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'aya-tail-'));
	const path = join(dir, 'j.jsonl');
	await writeFile(path, '{"n":1}\n');
	try {
		const inner = createLocalFs();
		let closed = false;
		const fs = {
			...inner,
			watch(p: string) {
				const h = inner.watch(p);
				return {
					close() {
						closed = true;
						h.close();
					},
					[Symbol.asyncIterator]: () => h[Symbol.asyncIterator](),
				};
			},
		};
		const tail = tailJsonl(fs, path, { quietMs: 15 });
		for await (const row of tail) {
			assert.deepEqual(row, { n: 1 });
			break;
		}
		await sleep(20);
		assert.equal(closed, true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('30 appends/s yields every line in order with about one read per second', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'aya-tail-'));
	const path = join(dir, 'j.jsonl');
	await writeFile(path, '');
	try {
		const inner = createLocalFs();
		let reads = 0;
		const fs = {
			...inner,
			async readRange(p: string, start: number, end?: number) {
				reads++;
				return inner.readRange(p, start, end);
			},
		};
		const tail = tailJsonl(fs, path, { quietMs: 25, maxLatencyMs: 1000 });
		const got: number[] = [];
		const consume = (async () => {
			for await (const row of tail) {
				got.push((row as { n: number }).n);
				if (got.length === 30) break;
			}
		})();
		for (let i = 0; i < 30; i++) {
			await appendFile(path, `${JSON.stringify({ n: i })}\n`);
			await sleep(20);
		}
		await consume;
		assert.deepEqual(got, [...Array(30).keys()]);
		assert.ok(reads >= 1 && reads <= 6, `expected about one read per second, got ${reads}`);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
