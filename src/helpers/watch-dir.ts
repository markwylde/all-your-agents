import { basename, dirname, join } from 'node:path';
import { systemClock } from './clock.ts';
import type { Coalescer } from './coalesce.ts';
import { coalesce } from './coalesce.ts';
import type { DebounceOptions, DirChange, Fs, WatchHandle } from './types.ts';

export type WatchDirHandle = {
	close(): void;
	ready: Promise<void>;
};

export function watchDir(
	fs: Fs,
	path: string,
	onChange: (event: DirChange) => void,
	opts: DebounceOptions = {},
): WatchDirHandle {
	const quietMs = opts.quietMs ?? 25;
	const maxLatencyMs = opts.maxLatencyMs ?? 1000;
	const clock = opts.clock ?? systemClock;
	const coalescer = coalesce(quietMs, maxLatencyMs, clock);
	let closed = false;
	let current: WatchHandle | undefined;

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

	/** Watch `path` if it is a directory, otherwise wait for it under its nearest ancestor. */
	const bind = async (): Promise<void> => {
		if (closed) return;
		const st = await fs.stat(path);
		if (st?.isDirectory) await watchEntries();
		else await awaitDirectory();
	};

	const watchEntries = async (): Promise<void> => {
		// Watch before scanning, so an entry created while the scan runs is still reported.
		const handle = open(path);
		if (!handle) {
			await awaitDirectory();
			return;
		}
		const known = new Set<string>();
		let gone = false;

		/** The directory itself went away: everything in it did too. Wait for it to return. */
		const directoryGone = async (): Promise<void> => {
			if (gone || closed) return;
			gone = true;
			release(handle);
			for (const name of [...known]) {
				known.delete(name);
				onChange({ type: 'delete', name, path: join(path, name) });
			}
			await bind();
		};

		const serviceName = async (name: string): Promise<void> => {
			if (closed || gone) return;
			const child = join(path, name);
			const st = await fs.stat(child);
			if (closed || gone) return;
			if (st) {
				const type = known.has(name) ? 'change' : 'create';
				known.add(name);
				onChange({ type, name, path: child });
				return;
			}
			if (known.delete(name)) onChange({ type: 'delete', name, path: child });
			if (!(await fs.stat(path))?.isDirectory) await directoryGone();
		};

		const rescan = async (): Promise<void> => {
			if (closed || gone) return;
			let names: string[];
			try {
				names = await fs.readDir(path);
			} catch {
				await directoryGone();
				return;
			}
			const seen = new Set(names);
			for (const name of names) await serviceName(name);
			for (const name of [...known]) {
				if (!seen.has(name)) await serviceName(name);
			}
		};

		void (async () => {
			try {
				for await (const event of handle) {
					if (closed || gone) return;
					const name = event.filename;
					if (name) coalescer.notify(join(path, name), () => void serviceName(name));
					else coalescer.notify(path, () => void rescan());
				}
			} catch {
				// watcher ended
			}
			if (closed || gone) return;
			if (!(await fs.stat(path))?.isDirectory) await directoryGone();
		})();

		let names: string[];
		try {
			names = await fs.readDir(path);
		} catch {
			await directoryGone();
			return;
		}
		for (const name of names) {
			if (closed || gone) return;
			// An event may have reported it already; creation is reported once.
			if (known.has(name)) continue;
			known.add(name);
			onChange({ type: 'create', name, path: join(path, name) });
		}
	};

	/**
	 * `path` is not a directory yet. Watch the nearest ancestor that is one, for the next
	 * segment on the way to `path`. When that appears, `bind` again: either `path` now
	 * exists or the nearest ancestor is one level deeper.
	 */
	const awaitDirectory = async (): Promise<void> => {
		let wanted = path;
		let existing = dirname(path);
		while (existing !== wanted && !(await fs.stat(existing))?.isDirectory) {
			wanted = existing;
			existing = dirname(existing);
		}
		const handle = open(existing);
		if (!handle) return;
		const name = basename(wanted);
		let found = false;
		const check = async (): Promise<void> => {
			if (closed || found) return;
			if (!(await fs.stat(wanted))?.isDirectory) return;
			if (closed || found) return;
			found = true;
			release(handle);
			await bind();
		};
		void (async () => {
			try {
				for await (const event of handle) {
					if (closed || found) return;
					if (event.filename && event.filename !== name) continue;
					coalescer.notify(wanted, () => void check());
				}
			} catch {
				// ended
			}
		})();
		// It may have appeared between the stat that missed it and the watch opening.
		await check();
	};

	const ready = bind().catch(() => {});

	return {
		ready,
		close() {
			closed = true;
			coalescer.dispose();
			current?.close();
			current = undefined;
		},
	};
}

export type { Coalescer };
