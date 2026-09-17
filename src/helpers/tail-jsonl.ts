import { basename, dirname } from 'node:path';
import { systemClock } from './clock.ts';
import { coalesce } from './coalesce.ts';
import type { DebounceOptions, Fs, WatchHandle } from './types.ts';

export type TailJsonlOptions = DebounceOptions & {
	/**
	 * `'separate'` delivers the records already in the file through `backlog` instead of
	 * through iteration, so a caller can tell stored records from live ones without
	 * reading the file twice.
	 */
	backlog?: 'separate';
};

export type TailJsonlHandle = AsyncIterable<unknown> & {
	close(): void;
	/** The records present when the tail opened, or `[]` unless `backlog: 'separate'`. */
	backlog: Promise<unknown[]>;
};

export function tailJsonl(fs: Fs, path: string, opts: TailJsonlOptions = {}): TailJsonlHandle {
	const quietMs = opts.quietMs ?? 25;
	const maxLatencyMs = opts.maxLatencyMs ?? 1000;
	const clock = opts.clock ?? systemClock;
	const coalescer = coalesce(quietMs, maxLatencyMs, clock);
	const queue: unknown[] = [];
	let wake: (() => void) | undefined;
	let closed = false;
	let failure: { error: unknown } | undefined;
	let offset = 0;
	let partial = '';
	// Reads end wherever the writer happens to be, which can be inside a character.
	let decoder = new TextDecoder();
	let reading = false;
	let queued = false;

	const wakeUp = (): void => {
		wake?.();
		wake = undefined;
	};

	const push = (item: unknown): void => {
		queue.push(item);
		wakeUp();
	};

	const parseChunk = (text: string, sink: (item: unknown) => void): void => {
		const data = partial + text;
		const lines = data.split('\n');
		partial = lines.pop() ?? '';
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				sink(JSON.parse(trimmed));
			} catch {
				// skip malformed complete lines
			}
		}
	};

	const readToEnd = async (sink: (item: unknown) => void): Promise<void> => {
		if (closed) return;
		const st = await fs.stat(path);
		if (!st) return;
		if (st.size < offset) {
			offset = 0;
			partial = '';
			decoder = new TextDecoder();
		}
		if (st.size === offset) return;
		const bytes = await fs.readRange(path, offset, st.size);
		offset += bytes.byteLength;
		parseChunk(decoder.decode(bytes, { stream: true }), sink);
	};

	const fail = (error: unknown): void => {
		if (closed || failure) return;
		failure = { error };
		wakeUp();
	};

	const readAppended = async (): Promise<void> => {
		reading = true;
		try {
			await readToEnd(push);
		} catch (error) {
			fail(error);
		} finally {
			reading = false;
			if (queued && !closed && !failure) {
				queued = false;
				void readAppended();
			}
		}
	};

	const requestRead = (): void => {
		if (closed || failure) return;
		if (reading) {
			queued = true;
			return;
		}
		void readAppended();
	};

	let handle: WatchHandle | undefined;
	try {
		handle = fs.watch(path);
	} catch {
		try {
			handle = fs.watch(dirname(path));
		} catch {
			handle = undefined;
		}
	}

	const follow = async (): Promise<void> => {
		if (!handle || closed) return;
		const name = basename(path);
		try {
			for await (const event of handle) {
				if (closed) break;
				if (event.filename && event.filename !== name) continue;
				coalescer.notify(path, requestRead);
			}
		} catch {
			// ended
		}
	};

	// The watch is already open, so nothing appended during the first read is lost.
	const firstRead = (async (): Promise<unknown[]> => {
		const stored: unknown[] = [];
		reading = true;
		try {
			await readToEnd(opts.backlog === 'separate' ? (item) => stored.push(item) : push);
		} finally {
			reading = false;
		}
		return stored;
	})();

	void firstRead.then(follow, fail);

	const close = (): void => {
		if (closed) return;
		closed = true;
		coalescer.dispose();
		handle?.close();
		wakeUp();
	};

	return {
		close,
		backlog: firstRead,
		async *[Symbol.asyncIterator]() {
			try {
				while (!closed || queue.length > 0) {
					if (queue.length > 0) {
						const next = queue.shift();
						yield next;
						continue;
					}
					if (failure) throw failure.error;
					if (closed) break;
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
