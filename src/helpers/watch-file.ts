import { basename, dirname } from 'node:path';
import { systemClock } from './clock.ts';
import { coalesce } from './coalesce.ts';
import type { FileChange, Fs, FsStat, WatchFileOptions, WatchHandle } from './types.ts';

export type WatchFileHandle = {
	close(): void;
};

const same = (a: FsStat | null, b: FsStat | null): boolean =>
	a === b || (a != null && b != null && a.size === b.size && a.mtimeMs === b.mtimeMs);

/**
 * Watches the parent directory, filtered by filename, never the file itself. A writer
 * that replaces the file by renaming a temporary sibling over it gives it a new inode;
 * inotify follows inodes, so a watch on the file goes silent after the first replace.
 * A missing parent is awaited under its nearest existing ancestor, one level at a time.
 *
 * With `heldOpen` the file is watched as well. On macOS a directory watch reports nothing
 * for writes through a handle the writer keeps open, so a SQLite WAL would look silent.
 * The parent watch still decides which file is at the path: the file watch is re-attached
 * whenever the parent reports that name.
 */
export function watchFile(
	fs: Fs,
	path: string,
	onChange: (event: FileChange) => void,
	opts: WatchFileOptions = {},
): WatchFileHandle {
	const quietMs = opts.quietMs ?? 25;
	const maxLatencyMs = opts.maxLatencyMs ?? 1000;
	const clock = opts.clock ?? systemClock;
	const coalescer = coalesce(quietMs, maxLatencyMs, clock);
	const late = coalesce(maxLatencyMs, maxLatencyMs, clock);
	const parent = dirname(path);
	const name = basename(path);
	let closed = false;
	let current: WatchHandle | undefined;
	/** What was last seen, to tell a real difference from a catch-up that found none. */
	let last: FsStat | null = null;
	const baseline = fs.stat(path).then(
		(st) => {
			last = st;
		},
		() => {},
	);

	let held: WatchHandle | undefined;
	/** Follow the file now at the path. The old handle may be on a replaced inode. */
	const holdFile = (): void => {
		if (!opts.heldOpen || closed) return;
		held?.close();
		held = undefined;
		let handle: WatchHandle;
		try {
			handle = fs.watch(path);
		} catch {
			return;
		}
		held = handle;
		void (async () => {
			try {
				for await (const _event of handle) {
					if (closed || held !== handle) return;
					coalescer.notify(path, () => void service(false));
				}
			} catch {
				// ended
			}
		})();
	};

	/** Notified: report whatever is there. Catching up: report only a difference. */
	const service = async (onlyIfDifferent: boolean): Promise<void> => {
		await baseline;
		if (closed) return;
		const st = await fs.stat(path).catch(() => null);
		if (closed) return;
		const before = last;
		last = st;
		if (onlyIfDifferent && same(before, st)) return;
		if (st) onChange({ type: 'change', path });
		else if (before) onChange({ type: 'delete', path });
	};

	/** Where watches can drop events while another opens or closes, look afterwards, and again once a slow rebuild surely has. */
	let catchUp: () => Promise<void> = () => service(true);
	const unsubscribe = fs.onWatchChurn?.(() => {
		if (closed) return;
		coalescer.notify(`churn:${path}`, () => void catchUp());
		late.notify(`churn:${path}`, () => void catchUp());
	});

	/** Open a watch, unless closed. Never await between the `closed` check and `current`. */
	const open = (target: string): WatchHandle | undefined => {
		if (closed) return undefined;
		try {
			current = fs.watch(target);
			return current;
		} catch {
			return undefined;
		}
	};

	const release = (handle: WatchHandle): void => {
		handle.close();
		if (current === handle) current = undefined;
	};

	const arm = async (): Promise<void> => {
		if (closed) return;
		const handle = (await fs.stat(parent).catch(() => null))?.isDirectory
			? open(parent)
			: undefined;
		if (handle) watchParent(handle);
		else await awaitParent();
	};

	const watchParent = (handle: WatchHandle): void => {
		catchUp = () => service(true);
		void (async () => {
			await baseline;
			try {
				for await (const event of handle) {
					if (closed) return;
					if (event.filename && event.filename !== name) continue;
					// A rename for our name means the file appeared, went, or was replaced.
					if (event.type === 'rename') holdFile();
					coalescer.notify(path, () => void service(false));
				}
			} catch {
				// ended
			}
			if (closed || current !== handle) return;
			// The parent went away: report the file gone, then wait for it to return.
			if ((await fs.stat(parent).catch(() => null))?.isDirectory) return;
			release(handle);
			await service(true);
			await arm();
		})();
	};

	/** Watch the nearest existing ancestor for the next segment on the way to `parent`. */
	const awaitParent = async (): Promise<void> => {
		let wanted = parent;
		let existing = dirname(parent);
		while (existing !== wanted && !(await fs.stat(existing).catch(() => null))?.isDirectory) {
			wanted = existing;
			existing = dirname(existing);
		}
		const handle = open(existing);
		if (!handle) return;
		const segment = basename(wanted);
		let found = false;
		const check = async (): Promise<void> => {
			if (closed || found) return;
			if (!(await fs.stat(wanted).catch(() => null))?.isDirectory) return;
			if (closed || found) return;
			found = true;
			release(handle);
			await arm();
			holdFile();
			// Anything created along with the directories was never notified.
			await service(true);
		};
		catchUp = check;
		void (async () => {
			try {
				for await (const event of handle) {
					if (closed || found) return;
					if (event.filename && event.filename !== segment) continue;
					coalescer.notify(wanted, () => void check());
				}
			} catch {
				// ended
			}
		})();
		// It may have appeared between the stat that missed it and the watch opening.
		await check();
	};

	// Opened now, so a write made right after this call is still notified.
	const first = open(parent);
	if (first) watchParent(first);
	else void baseline.then(awaitParent).catch(() => {});
	holdFile();

	return {
		close() {
			closed = true;
			unsubscribe?.();
			coalescer.dispose();
			late.dispose();
			current?.close();
			current = undefined;
			held?.close();
			held = undefined;
		},
	};
}
