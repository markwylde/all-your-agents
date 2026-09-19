import { watch as fsWatch } from 'node:fs';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { TooLargeError } from './bytes.ts';
import type { Fs, FsStat, FsWatchEvent, WatchHandle } from './types.ts';

function toStat(st: {
	size: number;
	mtimeMs: number;
	ino: number;
	isFile(): boolean;
	isDirectory(): boolean;
}): FsStat {
	return {
		size: st.size,
		mtimeMs: st.mtimeMs,
		isFile: st.isFile(),
		isDirectory: st.isDirectory(),
		ino: st.ino,
	};
}

/**
 * On macOS libuv serves every watch in the process from one FSEvents stream, and on each
 * add or remove destroys it and creates a new one that starts from "now". An event that
 * lands during the rebuild is never delivered, to any watch. So there, every open and
 * close is announced, process-wide, and the helpers catch up after it.
 */
const WATCHES_DISTURB_EACH_OTHER = process.platform === 'darwin';
const churnListeners = new Set<() => void>();

function watchChurned(): void {
	if (!WATCHES_DISTURB_EACH_OTHER) return;
	for (const listener of [...churnListeners]) listener();
}

function onWatchChurn(listener: () => void): () => void {
	churnListeners.add(listener);
	return () => {
		churnListeners.delete(listener);
	};
}

export function createLocalFs(): Fs {
	return {
		...(WATCHES_DISTURB_EACH_OTHER ? { onWatchChurn } : {}),
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
		watcher.removeAllListeners();
		watcher.close();
		wake?.();
		wake = undefined;
		watchChurned();
	};

	watchChurned();

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
