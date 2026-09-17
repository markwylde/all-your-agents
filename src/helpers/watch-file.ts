import { basename, dirname } from 'node:path';
import { systemClock } from './clock.js';
import { coalesce } from './coalesce.js';
import type { DebounceOptions, FileChange, Fs, WatchHandle } from './types.js';

export type WatchFileHandle = {
	close(): void;
};

export function watchFile(
	fs: Fs,
	path: string,
	onChange: (event: FileChange) => void,
	opts: DebounceOptions = {},
): WatchFileHandle {
	const quietMs = opts.quietMs ?? 25;
	const maxLatencyMs = opts.maxLatencyMs ?? 1000;
	const clock = opts.clock ?? systemClock;
	const coalescer = coalesce(quietMs, maxLatencyMs, clock);
	const parent = dirname(path);
	const name = basename(path);
	let closed = false;
	let existed = false;
	let handle: WatchHandle | undefined;
	try {
		handle = fs.watch(path);
	} catch {
		try {
			handle = fs.watch(parent);
		} catch {
			handle = undefined;
		}
	}

	const service = async (): Promise<void> => {
		if (closed) return;
		const st = await fs.stat(path);
		if (st) {
			existed = true;
			onChange({ type: 'change', path });
		} else if (existed) {
			existed = false;
			onChange({ type: 'delete', path });
		}
	};

	void (async () => {
		existed = Boolean(await fs.stat(path));
		if (!handle || closed) return;
		try {
			for await (const event of handle) {
				if (closed) break;
				if (event.filename && event.filename !== name && event.filename !== basename(path)) {
					continue;
				}
				coalescer.notify(path, () => {
					void service();
				});
			}
		} catch {
			// ended
		}
	})();

	return {
		close() {
			closed = true;
			coalescer.dispose();
			handle?.close();
		},
	};
}
