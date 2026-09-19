import type { ProcessInfo } from '../../helpers/types.ts';
import type { SessionKind } from '../../types.ts';

export const SESSION_FILE_MAX_BYTES = 64 * 1024;
export const START_TIME_TOLERANCE_MS = 5000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED = new Set([
	'pid',
	'sessionId',
	'cwd',
	'startedAt',
	'version',
	'status',
	'statusUpdatedAt',
	'waitingFor',
	'name',
	'updatedAt',
	'kind',
	'entrypoint',
	'spare',
	'jobId',
	'parkedJobId',
]);

export type ParsedSessionFile = {
	pid: number;
	sessionId: string;
	cwd?: string;
	startedAt?: number;
	version?: string;
	status?: string;
	statusUpdatedAt?: number;
	waitingFor?: string;
	name?: string;
	updatedAt?: number;
	kind?: SessionKind;
	entrypoint?: string;
	/** A pre-warmed daemon process nobody has claimed yet. */
	spare?: boolean;
	/** The background job this process runs. */
	jobId?: string;
	/** The background job an interactive process has handed its conversation to. */
	parkedJobId?: string;
};

export function parseSessionFile(
	filenamePid: number,
	bytes: Uint8Array,
	info: ProcessInfo,
): ParsedSessionFile | undefined {
	if (bytes.byteLength > SESSION_FILE_MAX_BYTES) return undefined;
	let raw: unknown;
	try {
		raw = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return undefined;
	}
	if (!raw || typeof raw !== 'object') return undefined;
	const rec = raw as Record<string, unknown>;
	const picked: Record<string, unknown> = {};
	for (const key of ALLOWED) {
		if (key in rec) picked[key] = rec[key];
	}
	const pid = picked.pid;
	const sessionId = picked.sessionId;
	if (typeof pid !== 'number' || pid !== filenamePid) return undefined;
	if (typeof sessionId !== 'string' || !UUID.test(sessionId)) return undefined;
	if (!info.alive) return undefined;
	if (typeof picked.startedAt === 'number' && info.startTime != null) {
		if (Math.abs(picked.startedAt - info.startTime) > START_TIME_TOLERANCE_MS) return undefined;
	}
	const kind = mapKind(picked.kind, picked.entrypoint);
	const out: ParsedSessionFile = { pid, sessionId };
	if (typeof picked.cwd === 'string') out.cwd = picked.cwd;
	if (typeof picked.startedAt === 'number') out.startedAt = picked.startedAt;
	if (typeof picked.version === 'string') out.version = picked.version;
	if (typeof picked.status === 'string') out.status = picked.status;
	if (typeof picked.statusUpdatedAt === 'number') out.statusUpdatedAt = picked.statusUpdatedAt;
	if (typeof picked.waitingFor === 'string') out.waitingFor = picked.waitingFor;
	if (typeof picked.name === 'string') out.name = picked.name;
	if (typeof picked.updatedAt === 'number') out.updatedAt = picked.updatedAt;
	if (kind) out.kind = kind;
	if (typeof picked.entrypoint === 'string') out.entrypoint = picked.entrypoint;
	if (picked.spare === true) out.spare = true;
	if (typeof picked.jobId === 'string' && picked.jobId) out.jobId = picked.jobId;
	if (typeof picked.parkedJobId === 'string' && picked.parkedJobId) {
		out.parkedJobId = picked.parkedJobId;
	}
	return out;
}

export function mapKind(kind: unknown, entrypoint: unknown): SessionKind | undefined {
	if (kind === 'interactive') return 'interactive';
	if (typeof kind === 'string' && kind && kind !== 'interactive') return 'headless';
	if (entrypoint === 'cli') return 'interactive';
	if (typeof entrypoint === 'string' && entrypoint) return 'headless';
	return undefined;
}

export const allowedSessionFields = [...ALLOWED];
