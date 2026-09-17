import { basename, dirname, join } from 'node:path';
import { systemClock } from './clock.js';
import type { Coalescer } from './coalesce.js';
import { coalesce } from './coalesce.js';
import type { DebounceOptions, DirChange, Fs, FsStat } from './types.js';

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
	let current: { close(): void } | undefined;
	let resolveReady: () => void = () => {};
	const ready = new Promise<void>((resolve) => {
		resolveReady = resolve;
	});

	const start = (): void => {
		void bind(path).finally(() => resolveReady());
	};

	const bind = async (target: string): Promise<void> => {
		if (closed) return;
		const st = await fs.stat(target);
		if (closed) return;
		if (st?.isDirectory) {
			await watchExisting(target);
			return;
		}
		await watchAncestor(target);
	};

	const watchExisting = async (dir: string): Promise<void> => {
		if (closed) return;
		const known = new Map<string, FsStat | true>();
		try {
			const names = await fs.readDir(dir);
			for (const name of names) {
				if (closed) return;
				const child = join(dir, name);
				const st = await fs.stat(child);
				known.set(name, st ?? true);
				onChange({ type: 'create', name, path: child });
			}
		} catch {
			if (closed) return;
			await watchAncestor(dir);
			return;
		}

		const handle = fs.watch(dir);
		current = handle;
		const serviceName = async (name: string): Promise<void> => {
			if (closed) return;
			const child = join(dir, name);
			const st = await fs.stat(child);
			const had = known.has(name);
			if (st) {
				known.set(name, st);
				onChange({ type: had ? 'change' : 'create', name, path: child });
			} else if (had) {
				known.delete(name);
				onChange({ type: 'delete', name, path: child });
			}
		};

		void (async () => {
			try {
				for await (const event of handle) {
					if (closed) break;
					if (event.filename) {
						const name = event.filename;
						coalescer.notify(join(dir, name), () => {
							void serviceName(name);
						});
					} else {
						coalescer.notify(dir, () => {
							void (async () => {
								if (closed) return;
								let names: string[] = [];
								try {
									names = await fs.readDir(dir);
								} catch {
									return;
								}
								const seen = new Set(names);
								for (const name of names) {
									await serviceName(name);
								}
								for (const name of [...known.keys()]) {
									if (!seen.has(name)) await serviceName(name);
								}
							})();
						});
					}
				}
			} catch {
				// watcher ended
			}
		})();
	};

	const watchAncestor = async (target: string): Promise<void> => {
		if (closed) return;
		const chain: string[] = [];
		let cursor = target;
		for (;;) {
			const st = await fs.stat(cursor);
			if (st) {
				await watchUntilChild(cursor, chain);
				return;
			}
			chain.unshift(cursor);
			const parent = dirname(cursor);
			if (parent === cursor) {
				await watchUntilChild(cursor, chain);
				return;
			}
			cursor = parent;
		}
	};

	const watchUntilChild = async (existing: string, missing: string[]): Promise<void> => {
		if (closed) return;
		if (missing.length === 0) {
			await watchExisting(existing);
			return;
		}
		const next = missing[0];
		if (!next) return;
		const wanted = basename(next);
		const handle = fs.watch(existing);
		current = handle;
		const check = async (): Promise<void> => {
			if (closed) return;
			const st = await fs.stat(next);
			if (!st) return;
			handle.close();
			await bind(next);
		};
		void check();
		void (async () => {
			try {
				for await (const event of handle) {
					if (closed) break;
					if (event.filename && event.filename !== wanted) continue;
					coalescer.notify(next, () => {
						void check();
					});
				}
			} catch {
				// ended
			}
		})();
	};

	start();

	return {
		ready,
		close() {
			closed = true;
			coalescer.dispose();
			current?.close();
			current = undefined;
			resolveReady();
		},
	};
}

export type { Coalescer };
