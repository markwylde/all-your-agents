import { decodeUtf8 } from '../../helpers/bytes.ts';
import type { Fs, WatchHandle } from '../../helpers/types.ts';
import type { WatchContext } from '../../provider.ts';

/** How much of the end of the shared log a bind looks through for a rewind it missed. */
export const RECENT_LOG_BYTES = 1024 * 1024;

const REWIND_MSG = 'shell.cancel.rewind_decision';

/**
 * A cancel that Grok answered by rewinding the prompt. A cancel before any output does
 * that, and then writes no `turn_ended` anywhere in the session directory: this line in
 * `logs/unified.jsonl` is the only trace that the turn is over.
 */
export type Rewind = { sessionId: string; pid?: number; at?: number };

export function parseRewind(rec: unknown): Rewind | undefined {
	if (!rec || typeof rec !== 'object') return undefined;
	const row = rec as Record<string, unknown>;
	if (row.msg !== REWIND_MSG || typeof row.sid !== 'string') return undefined;
	const ctx = row.ctx as Record<string, unknown> | undefined;
	if (ctx?.rewind_disposition !== 'rewound') return undefined;
	const at = typeof row.ts === 'string' ? Date.parse(row.ts) : Number.NaN;
	return {
		sessionId: row.sid,
		pid: typeof row.pid === 'number' ? row.pid : undefined,
		at: Number.isFinite(at) ? at : undefined,
	};
}

function rewindsIn(text: string): Rewind[] {
	const out: Rewind[] = [];
	for (const line of text.split('\n')) {
		// Every Grok process logs here constantly; parse only the lines that can matter.
		if (!line.includes(REWIND_MSG)) continue;
		try {
			const rewind = parseRewind(JSON.parse(line));
			if (rewind) out.push(rewind);
		} catch {
			// torn or malformed line
		}
	}
	return out;
}

/** The rewinds in the last `RECENT_LOG_BYTES` of the log. */
export async function recentRewinds(fs: Fs, path: string): Promise<Rewind[]> {
	try {
		const st = await fs.stat(path);
		if (!st) return [];
		const from = Math.max(0, st.size - RECENT_LOG_BYTES);
		let text = decodeUtf8(await fs.readRange(path, from, st.size));
		// Starting mid-file, the first line is cut off.
		if (from > 0) text = text.slice(text.indexOf('\n') + 1);
		return rewindsIn(text);
	} catch {
		return [];
	}
}

/**
 * Follow rewinds appended to the log from now on. The log is shared and large, so it is
 * never read from the start; one that shrinks was rotated and is read from the top.
 *
 * Grok appends through a handle it never closes, and on macOS a directory watch reports
 * nothing for those writes until the close. So the file itself is watched; the directory
 * watch only notices it being created or replaced, and moves the file watch over.
 */
export function followRewinds(
	ctx: WatchContext,
	path: string,
	onRewind: (rewind: Rewind) => void,
): { close(): void } {
	let closed = false;
	let offset: number | undefined;
	let partial = '';
	// Reads end wherever the writers happen to be, which can be inside a character.
	let decoder = new TextDecoder();
	let pending: Promise<void> = Promise.resolve();

	const read = async (): Promise<void> => {
		const st = await ctx.fs.stat(path).catch(() => null);
		if (closed) return;
		if (offset == null) {
			// Only what is appended from now on; a log created later is read from its top.
			offset = st?.size ?? 0;
			return;
		}
		if (!st) return;
		if (st.size < offset) {
			offset = 0;
			partial = '';
			decoder = new TextDecoder();
		}
		if (st.size === offset) return;
		const bytes = await ctx.fs.readRange(path, offset, st.size);
		if (closed) return;
		offset += bytes.byteLength;
		const text = partial + decoder.decode(bytes, { stream: true });
		const end = text.lastIndexOf('\n');
		partial = text.slice(end + 1);
		for (const rewind of rewindsIn(text.slice(0, end + 1))) onRewind(rewind);
	};

	const service = (): void => {
		pending = pending.then(read).catch((error: unknown) => {
			if (!closed) ctx.reportError(error);
		});
	};

	let file: WatchHandle | undefined;
	const watchItself = (): void => {
		file?.close();
		file = undefined;
		if (closed) return;
		let handle: WatchHandle;
		try {
			handle = ctx.fs.watch(path);
		} catch {
			// Not there yet: the directory watch reports it when it is.
			return;
		}
		file = handle;
		void (async () => {
			try {
				for await (const _ of handle) {
					if (closed || file !== handle) break;
					service();
				}
			} catch {
				// ended
			}
		})();
	};

	const dir = ctx.watchFile(path, (change) => {
		if (closed) return;
		if (change.type === 'change') watchItself();
		service();
	});
	watchItself();
	service();
	return {
		close() {
			closed = true;
			dir.close();
			file?.close();
		},
	};
}
