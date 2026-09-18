import { decodeUtf8 } from '../../helpers/bytes.ts';
import type { SubagentStatus } from '../../types.ts';

export const META_MAX_BYTES = 256 * 1024;

export type SubagentMeta = {
	subagentId: string;
	parentSessionId?: string;
	childSessionId?: string;
	type: string;
	title?: string;
	status: SubagentStatus;
	childCwd?: string;
	startedAt?: number;
	endedAt?: number;
};

const time = (value: unknown): number | undefined => {
	if (typeof value !== 'string') return undefined;
	const n = Date.parse(value);
	return Number.isFinite(n) ? n : undefined;
};

export function metaStatus(word: unknown): SubagentStatus {
	if (word === 'completed') return 'completed';
	if (word === 'failed' || word === 'error') return 'failed';
	if (word === 'cancelled' || word === 'killed' || word === 'interrupted') return 'cancelled';
	return 'running';
}

/**
 * `subagents/<id>/meta.json`. `output.json` beside it means the run finished, which
 * counts as completed when the meta has no final status yet.
 */
export function parseMeta(bytes: Uint8Array, hasOutput = false): SubagentMeta | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(decodeUtf8(bytes));
	} catch {
		return undefined;
	}
	if (!raw || typeof raw !== 'object') return undefined;
	const row = raw as Record<string, unknown>;
	if (typeof row.subagent_id !== 'string' || !row.subagent_id) return undefined;
	let status = metaStatus(row.status);
	if (status === 'running' && hasOutput) status = 'completed';
	const meta: SubagentMeta = {
		subagentId: row.subagent_id,
		type: typeof row.subagent_type === 'string' ? row.subagent_type : 'general-purpose',
		status,
	};
	if (typeof row.parent_session_id === 'string') meta.parentSessionId = row.parent_session_id;
	if (typeof row.child_session_id === 'string') meta.childSessionId = row.child_session_id;
	if (typeof row.description === 'string') meta.title = row.description;
	if (typeof row.child_cwd === 'string') meta.childCwd = row.child_cwd;
	const startedAt = time(row.started_at);
	if (startedAt != null) meta.startedAt = startedAt;
	const endedAt = time(row.completed_at);
	if (endedAt != null && status !== 'running') meta.endedAt = endedAt;
	return meta;
}

export type SpawnArgs = { type: string; title?: string; background: boolean };

/** The arguments of a `spawn_subagent` tool call, which Grok stores as a JSON string. */
export function parseSpawnArgs(args: unknown): SpawnArgs {
	let input: Record<string, unknown> = {};
	if (typeof args === 'string') {
		try {
			const parsed = JSON.parse(args);
			if (parsed && typeof parsed === 'object') input = parsed as Record<string, unknown>;
		} catch {}
	} else if (args && typeof args === 'object') {
		input = args as Record<string, unknown>;
	}
	return {
		type: typeof input.subagent_type === 'string' ? input.subagent_type : 'general-purpose',
		title: typeof input.description === 'string' ? input.description : undefined,
		background: input.background === true,
	};
}

/** What a `spawn_subagent` tool result says: the subagent it launched, and how. */
export function parseSpawnResult(text: string): {
	subagentId?: string;
	background: boolean;
	completed: boolean;
} {
	const id =
		/(?:^|\n)subagent_id:\s*(\S+)/.exec(text)?.[1] ??
		/<subagent_meta>id=([^,<\s]+)/.exec(text)?.[1];
	return {
		subagentId: id,
		background:
			text.startsWith('Subagent started in background') || text.includes('moved to the background'),
		completed: text.includes('<subagent_result>') || text.includes('<subagent_meta>'),
	};
}
