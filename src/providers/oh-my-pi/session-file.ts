import { basename } from 'node:path';
import { decodeUtf8 } from '../../helpers/bytes.ts';
import type { Fs } from '../../helpers/types.ts';
import type { TitleSource } from '../../types.ts';
import { isUuid, parseSessionFileName } from './paths.ts';

export const HEAD_MAX_BYTES = 64 * 1024;

export type SessionHead = {
	id: string;
	cwd: string;
	startedAt?: number;
	/** The transcript that spawned this one, for a subagent. */
	parentSession?: string;
	title?: string;
	titleSource?: Exclude<TitleSource, 'process' | 'prompt'>;
};

function parseLine(line: string): Record<string, unknown> | undefined {
	try {
		const raw: unknown = JSON.parse(line);
		return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function titleOf(
	row: Record<string, unknown> | undefined,
): Pick<SessionHead, 'title' | 'titleSource'> {
	const title = typeof row?.title === 'string' ? row.title.trim() : '';
	if (!title) return {};
	const source = row?.source ?? row?.titleSource;
	return { title, titleSource: source === 'user' ? 'user' : 'harness' };
}

/**
 * Line 1 is a fixed-width title slot omp overwrites in place; line 2 is the `session`
 * header. Transcripts from before the slot existed start with the header.
 */
export function parseHead(text: string): SessionHead | undefined {
	const lines = text.split('\n');
	const first = parseLine(lines[0] ?? '');
	if (!first) return undefined;
	const slot = first.type === 'title' ? first : undefined;
	const header = slot ? parseLine(lines[1] ?? '') : first;
	if (header?.type !== 'session' || !isUuid(header.id)) return undefined;
	if (typeof header.cwd !== 'string' || !header.cwd) return undefined;
	const head: SessionHead = { id: header.id.toLowerCase(), cwd: header.cwd };
	const at = typeof header.timestamp === 'string' ? Date.parse(header.timestamp) : Number.NaN;
	if (Number.isFinite(at)) head.startedAt = at;
	if (typeof header.parentSession === 'string' && header.parentSession) {
		head.parentSession = header.parentSession;
	}
	const titled = slot ? titleOf(slot) : {};
	return { ...head, ...(titled.title ? titled : titleOf(header)) };
}

/**
 * A bounded read of the head. `requireNameMatch` rejects a file whose name names another id;
 * a custom-named file names none and is taken at its header's word.
 */
export async function readHead(
	fs: Fs,
	path: string,
	opts: { requireNameMatch?: boolean } = {},
): Promise<SessionHead | undefined> {
	let text: string;
	try {
		text = decodeUtf8(await fs.readRange(path, 0, HEAD_MAX_BYTES));
	} catch {
		return undefined;
	}
	// A header that does not end inside the bound is cut short and fails to parse: refused.
	const head = parseHead(text);
	if (!head) return undefined;
	if (opts.requireNameMatch) {
		const named = parseSessionFileName(basename(path));
		if (named && named.id !== head.id) return undefined;
	}
	return head;
}
