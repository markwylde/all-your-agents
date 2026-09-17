import { watch as fsWatch } from 'node:fs';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { TooLargeError } from './bytes.js';
import type { Fs, FsStat, FsWatchEvent, WatchHandle } from './types.js';

function toStat(st: {
	size: number;
	mtimeMs: number;
	isFile(): boolean;
	isDirectory(): boolean;
}): FsStat {
	return {
		size: st.size,
		mtimeMs: st.mtimeMs,
		isFile: st.isFile(),
		isDirectory: st.isDirectory(),
	};
}

export function createLocalFs(): Fs {
	return {
		async readFile(path, opts) {
			if (opts?.maxBytes != null) {
				const st = await this.stat(path);
				if (st && st.size > opts.maxBytes) {
					throw new TooLargeError(path, st.size, opts.maxBytes);
				}
			}
			const buf = await readFile(path);
			return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
		},
		async readRange(path, start, end) {
			const handle = await open(path, 'r');
			try {
				const st = await handle.stat();
				const from = Math.max(0, start);
				const to = end == null ? st.size : Math.min(end, st.size);
				if (to <= from) return new Uint8Array(0);
				const length = to - from;
				const buf = Buffer.alloc(length);
				const { bytesRead } = await handle.read(buf, 0, length, from);
				return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
			} finally {
				await handle.close();
			}
		},
		async readDir(path) {
			return readdir(path);
		},
		async stat(path) {
			try {
				return toStat(await stat(path));
			} catch (err) {
				if (isEnoent(err)) return null;
				throw err;
			}
		},
		watch(path) {
			return watchPath(path);
		},
	};
}

export function isEnoent(err: unknown): boolean {
	return Boolean(err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT');
}

function watchPath(path: string): WatchHandle {
	const queue: FsWatchEvent[] = [];
	let wake: (() => void) | undefined;
	let closed = false;
	const watcher = fsWatch(path, (eventType, filename) => {
		if (closed) return;
		queue.push({
			type: eventType === 'rename' ? 'rename' : 'change',
			filename: filename == null ? null : filename.toString(),
		});
		wake?.();
		wake = undefined;
	});
	watcher.on('error', () => {
		if (closed) return;
		closed = true;
		wake?.();
		wake = undefined;
	});

	const close = (): void => {
		if (closed) return;
		closed = true;
		watcher.close();
		wake?.();
		wake = undefined;
	};

	return {
		close,
		async *[Symbol.asyncIterator]() {
			try {
				while (!closed) {
					if (queue.length > 0) {
						const next = queue.shift();
						if (next) yield next;
						continue;
					}
					await new Promise<void>((resolve) => {
						wake = resolve;
					});
				}
			} finally {
				close();
			}
		},
	};
}
