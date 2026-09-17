import { createLocalFs } from '../../src/helpers/fs.js';
import type { Fs, WatchHandle } from '../../src/helpers/types.js';

export type SpyFs = Fs & {
	/** Bytes returned by `readRange` and `readFile`, per path. */
	bytesRead: Map<string, number>;
	/** Paths with a watch that has been opened and not yet closed. */
	openWatches(): string[];
	/** Runs inside the next matching call, after the real one has produced its result. */
	hooks: {
		readDir?: (path: string) => Promise<void> | void;
		stat?: (path: string) => Promise<void> | void;
	};
};

/** The local filesystem, recording what was read and which watches are still open. */
export function spyFs(inner: Fs = createLocalFs()): SpyFs {
	const bytesRead = new Map<string, number>();
	const open = new Map<WatchHandle, string>();
	const count = (path: string, bytes: Uint8Array): Uint8Array => {
		bytesRead.set(path, (bytesRead.get(path) ?? 0) + bytes.byteLength);
		return bytes;
	};
	const fs: SpyFs = {
		bytesRead,
		hooks: {},
		openWatches: () => [...open.values()],
		...(inner.onWatchChurn ? { onWatchChurn: inner.onWatchChurn.bind(inner) } : {}),
		readFile: async (path, opts) => count(path, await inner.readFile(path, opts)),
		readRange: async (path, start, end) => count(path, await inner.readRange(path, start, end)),
		async readDir(path) {
			const names = await inner.readDir(path);
			await fs.hooks.readDir?.(path);
			return names;
		},
		async stat(path) {
			const st = await inner.stat(path);
			await fs.hooks.stat?.(path);
			return st;
		},
		watch(path) {
			const handle = inner.watch(path);
			const wrapped: WatchHandle = {
				close() {
					open.delete(wrapped);
					handle.close();
				},
				[Symbol.asyncIterator]: () => handle[Symbol.asyncIterator](),
			};
			open.set(wrapped, path);
			return wrapped;
		},
	};
	return fs;
}
