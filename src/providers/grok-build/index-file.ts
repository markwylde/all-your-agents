import { decodeUtf8 } from '../../helpers/bytes.ts';
import type { ProcessInfo } from '../../helpers/types.ts';

export const INDEX_MAX_BYTES = 256 * 1024;
export const OPENED_AT_TOLERANCE_MS = 5000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The only fields read from an `active_sessions.json` entry. */
const ALLOWED = ['session_id', 'pid', 'cwd', 'opened_at'] as const;

export type IndexEntry = {
	sessionId: string;
	pid: number;
	cwd: string;
	/** Registration time: every load, resume or new session, not the process start. */
	openedAt?: number;
};

/**
 * The structurally valid entries, or undefined when the file as a whole is unusable
 * (oversized, not JSON, not an array). A torn write then changes nothing.
 */
export function parseIndex(bytes: Uint8Array): IndexEntry[] | undefined {
	if (bytes.byteLength > INDEX_MAX_BYTES) return undefined;
	let raw: unknown;
	try {
		raw = JSON.parse(decodeUtf8(bytes));
	} catch {
		return undefined;
	}
	if (!Array.isArray(raw)) return undefined;
	const out: IndexEntry[] = [];
	for (const item of raw) {
		if (!item || typeof item !== 'object') continue;
		const row = item as Record<string, unknown>;
		const picked: Record<string, unknown> = {};
		for (const key of ALLOWED) picked[key] = row[key];
		const { session_id: sessionId, pid, cwd, opened_at: openedAt } = picked;
		if (typeof sessionId !== 'string' || !UUID.test(sessionId)) continue;
		if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) continue;
		if (typeof cwd !== 'string' || !cwd) continue;
		const entry: IndexEntry = { sessionId, pid, cwd };
		const at = typeof openedAt === 'string' ? Date.parse(openedAt) : Number.NaN;
		if (Number.isFinite(at)) entry.openedAt = at;
		out.push(entry);
	}
	return out;
}

/**
 * The process is alive and registered the entry after it started. There is no upper
 * bound: a `/resume` long after launch registers again. A recycled pid fails, because
 * the old entry was registered before the new process started.
 */
export function acceptEntry(entry: IndexEntry, info: ProcessInfo): boolean {
	if (!info.alive) return false;
	if (info.startTime == null) return true;
	if (entry.openedAt == null) return false;
	return entry.openedAt >= info.startTime - OPENED_AT_TOLERANCE_MS;
}

export const allowedIndexFields = [...ALLOWED];
