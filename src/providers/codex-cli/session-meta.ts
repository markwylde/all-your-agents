import { decodeUtf8 } from '../../helpers/bytes.ts';
import type { ProcessInfo } from '../../helpers/types.ts';
import type { SessionKind } from '../../types.ts';

export const SESSION_META_MAX_BYTES = 1024 * 1024;
export const START_TIME_TOLERANCE_MS = 5000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NOT_ROOT_THREAD = new Set(['subagent', 'guardian_review', 'memory_consolidation']);

export const ALLOWED_META_FIELDS = [
	'session_id',
	'id',
	'forked_from_id',
	'parent_thread_id',
	'timestamp',
	'cwd',
	'source',
	'thread_source',
	'originator',
	'cli_version',
	'agent_nickname',
	'agent_role',
	'agent_path',
	'model_provider',
] as const;

export type SessionMeta = {
	id: string;
	sessionId?: string;
	cwd: string;
	timestamp?: number;
	source?: unknown;
	threadSource?: string;
	parentThreadId?: string;
	forkedFromId?: string;
	kind: SessionKind;
	agentNickname?: string;
	agentRole?: string;
	agentPath?: string;
	root: boolean;
};

function envelopePayload(raw: unknown): Record<string, unknown> | undefined {
	if (!raw || typeof raw !== 'object') return undefined;
	const row = raw as Record<string, unknown>;
	if (row.type === 'session_meta' && row.payload && typeof row.payload === 'object') {
		return row.payload as Record<string, unknown>;
	}
	if (typeof row.id === 'string') return row;
	return undefined;
}

function sourceKind(source: unknown): SessionKind {
	if (source === 'exec' || source === 'mcp') return 'headless';
	return 'interactive';
}

function isSubagentSource(source: unknown): boolean {
	return Boolean(source && typeof source === 'object' && 'subagent' in source);
}

export function parseSessionMeta(bytes: Uint8Array): SessionMeta | undefined {
	const limited =
		bytes.byteLength > SESSION_META_MAX_BYTES ? bytes.subarray(0, SESSION_META_MAX_BYTES) : bytes;
	const text = decodeUtf8(limited);
	const nl = text.indexOf('\n');
	if (nl === -1 && limited.byteLength >= SESSION_META_MAX_BYTES) return undefined;
	const line = (nl === -1 ? text : text.slice(0, nl)).trim();
	if (!line) return undefined;
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		return undefined;
	}
	const payload = envelopePayload(raw);
	if (!payload) return undefined;
	const id = payload.id;
	if (typeof id !== 'string' || !UUID.test(id)) return undefined;
	const cwd = payload.cwd;
	if (typeof cwd !== 'string' || !cwd) return undefined;
	const threadSource =
		typeof payload.thread_source === 'string' ? payload.thread_source : undefined;
	const parentThreadId =
		typeof payload.parent_thread_id === 'string' ? payload.parent_thread_id : undefined;
	const root =
		!parentThreadId &&
		!(threadSource && NOT_ROOT_THREAD.has(threadSource)) &&
		!isSubagentSource(payload.source);
	const out: SessionMeta = {
		id,
		cwd,
		kind: sourceKind(payload.source),
		root,
	};
	if (typeof payload.session_id === 'string') out.sessionId = payload.session_id;
	const ts = typeof payload.timestamp === 'string' ? Date.parse(payload.timestamp) : Number.NaN;
	if (Number.isFinite(ts)) out.timestamp = ts;
	if (payload.source !== undefined) out.source = payload.source;
	if (threadSource) out.threadSource = threadSource;
	if (parentThreadId) out.parentThreadId = parentThreadId;
	if (typeof payload.forked_from_id === 'string') out.forkedFromId = payload.forked_from_id;
	if (typeof payload.agent_nickname === 'string') out.agentNickname = payload.agent_nickname;
	if (typeof payload.agent_role === 'string') out.agentRole = payload.agent_role;
	if (typeof payload.agent_path === 'string') out.agentPath = payload.agent_path;
	return out;
}

export function acceptMeta(meta: SessionMeta, info: ProcessInfo): boolean {
	if (!info.alive) return false;
	if (info.startTime == null) return true;
	if (meta.timestamp == null) return false;
	return meta.timestamp >= info.startTime - START_TIME_TOLERANCE_MS;
}

export const allowedMetaFields = [...ALLOWED_META_FIELDS];
