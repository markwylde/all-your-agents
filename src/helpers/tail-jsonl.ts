import { basename, dirname } from 'node:path';
import { decodeUtf8 } from './bytes.ts';
import { systemClock } from './clock.ts';
import { coalesce } from './coalesce.ts';
import type { DebounceOptions, Fs, WatchHandle } from './types.ts';

export type TailJsonlHandle = AsyncIterable<unknown> & {
	close(): void;
};

export function tailJsonl(fs: Fs, path: string, opts: DebounceOptions = {}): TailJsonlHandle {
	const quietMs = opts.quietMs ?? 25;
	const maxLatencyMs = opts.maxLatencyMs ?? 1000;
	const clock = opts.clock ?? systemClock;
	const coalescer = coalesce(quietMs, maxLatencyMs, clock);
	const queue: unknown[] = [];
	let wake: (() => void) | undefined;
	let closed = false;
	let offset = 0;
	let partial = '';
	let reading = false;
	let queued = false;

	const push = (item: unknown): void => {
		queue.push(item);
		wake?.();
		wake = undefined;
	};

	const parseChunk = (text: string): void => {
		const data = partial + text;
		const lines = data.split('\n');
		partial = lines.pop() ?? '';
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				push(JSON.parse(trimmed));
			} catch {
				// skip malformed complete lines
			}
		}
	};

	const readToEnd = async (): Promise<void> => {
		if (closed) return;
		reading = true;
		try {
			const st = await fs.stat(path);
			if (!st) return;
			if (st.size < offset) {
				offset = 0;
				partial = '';
			}
			if (st.size === offset) return;
			const bytes = await fs.readRange(path, offset, st.size);
			offset += bytes.byteLength;
			parseChunk(decodeUtf8(bytes));
		} finally {
			reading = false;
			if (queued && !closed) {
				queued = false;
				void readToEnd();
			}
		}
	};

	const requestRead = (): void => {
		if (closed) return;
		if (reading) {
			queued = true;
			return;
		}
		void readToEnd();
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

	void (async () => {
		await readToEnd();
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
	})();

	const close = (): void => {
		if (closed) return;
		closed = true;
		coalescer.dispose();
		handle?.close();
		wake?.();
		wake = undefined;
	};

	return {
		close,
		async *[Symbol.asyncIterator]() {
			try {
				while (!closed || queue.length > 0) {
					if (queue.length > 0) {
						const next = queue.shift();
						yield next;
						continue;
					}
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
