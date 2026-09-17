import { basename, dirname } from 'node:path';
import { systemClock } from './clock.ts';
import { coalesce } from './coalesce.ts';
import type { DebounceOptions, FileChange, Fs, FsStat, WatchHandle } from './types.ts';

export type WatchFileHandle = {
	close(): void;
};

const same = (a: FsStat | null, b: FsStat | null): boolean =>
	a === b || (a != null && b != null && a.size === b.size && a.mtimeMs === b.mtimeMs);

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
	/** What was last seen, to tell a real difference from a catch-up that found none. */
	let last: FsStat | null = null;
	const baseline = fs.stat(path).then(
		(st) => {
			last = st;
		},
		() => {},
	);

	/** Notified: report whatever is there. Catching up: report only a difference. */
	const service = async (onlyIfDifferent: boolean): Promise<void> => {
		await baseline;
		if (closed) return;
		const st = await fs.stat(path);
		if (closed) return;
		const before = last;
		last = st;
		if (onlyIfDifferent && same(before, st)) return;
		if (st) onChange({ type: 'change', path });
		else if (before) onChange({ type: 'delete', path });
	};

	const unsubscribe = fs.onWatchChurn?.(() => {
		if (!closed) coalescer.notify(`churn:${path}`, () => void service(true));
	});

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

	void (async () => {
		await baseline;
		if (!handle || closed) return;
		try {
			for await (const event of handle) {
				if (closed) break;
				if (event.filename && event.filename !== name) continue;
				coalescer.notify(path, () => void service(false));
			}
		} catch {
			// ended
		}
	})();

	return {
		close() {
			closed = true;
			unsubscribe?.();
			coalescer.dispose();
			handle?.close();
		},
	};
}
