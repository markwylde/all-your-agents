import type { SubagentStatus } from '../../types.ts';

export type CollabHint = {
	tool?: string;
	ids: string[];
	nicknames: Map<string, string>;
	states: Map<string, SubagentStatus | 'open'>;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function toolName(tool: unknown): string | undefined {
	if (typeof tool === 'string') return tool;
	return undefined;
}

function agentStatus(value: unknown): SubagentStatus | 'open' | undefined {
	if (value === 'pending_init' || value === 'running') return 'open';
	if (value === 'completed') return 'completed';
	if (value === 'errored') return 'failed';
	if (value === 'interrupted' || value === 'shutdown' || value === 'not_found') return 'cancelled';
	const rec = asRecord(value);
	if (!rec) return undefined;
	if ('completed' in rec) return 'completed';
	if ('errored' in rec) return 'failed';
	return undefined;
}

/** `item_completed` `CollabAgentToolCall` — optional earlier hint in paginated mode. */
export function parseCollabItem(item: unknown): CollabHint | undefined {
	const rec = asRecord(item);
	if (!rec) return undefined;
	if (rec.type !== 'CollabAgentToolCall') return undefined;
	const tool = toolName(rec.tool);
	const ids: string[] = [];
	const nicknames = new Map<string, string>();
	const receivers = rec.receiver_agents;
	if (Array.isArray(receivers)) {
		for (const agent of receivers) {
			const row = asRecord(agent);
			if (!row || typeof row.thread_id !== 'string') continue;
			ids.push(row.thread_id);
			if (typeof row.agent_nickname === 'string') nicknames.set(row.thread_id, row.agent_nickname);
		}
	}
	const states = new Map<string, SubagentStatus | 'open'>();
	const rawStates = asRecord(rec.agents_states);
	if (rawStates) {
		for (const [id, value] of Object.entries(rawStates)) {
			const status = agentStatus(value);
			if (status) states.set(id, status);
		}
	}
	return { tool, ids, nicknames, states };
}

export function spawnIds(hint: CollabHint): string[] {
	if (hint.tool !== 'spawn_agent') return [];
	return hint.ids;
}

export function completionOf(
	hint: CollabHint,
	id: string,
): Exclude<SubagentStatus, 'running'> | undefined {
	if (hint.tool !== 'wait' && hint.tool !== 'close_agent') return undefined;
	const status = hint.states.get(id);
	if (!status || status === 'open' || status === 'running') return undefined;
	return status;
}
