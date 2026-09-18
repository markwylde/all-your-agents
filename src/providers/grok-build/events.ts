import type { SessionStatus, TurnFact } from '../../types.ts';
import { phaseStatus } from './status.ts';

/** What `events.jsonl` has said so far about the current turn. */
export type EventsState = {
	turnOpen: boolean;
	phase?: string;
	/** Tool named by the latest `permission_requested`. */
	waitingFor?: string;
	/** Tools started and not completed, by name: `tool_started` carries no call id. */
	openTools: string[];
	/** A turn or tool has been reported and not ended. */
	activityOpen: boolean;
	model?: string;
};

export function initialEventsState(): EventsState {
	return { turnOpen: false, openTools: [], activityOpen: false };
}

export function eventTime(rec: Record<string, unknown>): number | undefined {
	const ts = rec.ts;
	if (typeof ts !== 'string') return undefined;
	const n = Date.parse(ts);
	return Number.isFinite(n) ? n : undefined;
}

export function deriveStatus(state: EventsState): { status?: SessionStatus; waitingFor?: string } {
	if (!state.turnOpen) return { status: 'idle' };
	const status = phaseStatus(state.phase);
	if (status === 'waiting') return { status, waitingFor: state.waitingFor };
	return status ? { status } : {};
}

const OUTCOMES: Record<string, 'completed' | 'failed' | 'interrupted'> = {
	completed: 'completed',
	error: 'failed',
	cancelled: 'interrupted',
};

export function closeOpenTurn(hasOpenTool: boolean, at?: number): TurnFact {
	return { type: 'turn-ended', outcome: hasOpenTool ? 'interrupted' : 'completed', endedAt: at };
}

/**
 * Apply one `events.jsonl` record to `state` and return the turn facts it produces.
 * MCP setup and other bookkeeping records produce none. When the status this leaves is
 * `idle` while a turn or tool is still open, that turn is closed here.
 */
export function reduceEvent(state: EventsState, rec: unknown): TurnFact[] {
	if (!rec || typeof rec !== 'object') return [];
	const row = rec as Record<string, unknown>;
	const at = eventTime(row);
	const facts: TurnFact[] = [];
	switch (row.type) {
		case 'turn_started':
			state.turnOpen = true;
			delete state.phase;
			delete state.waitingFor;
			state.openTools = [];
			state.activityOpen = true;
			if (typeof row.model_id === 'string' && row.model_id) state.model = row.model_id;
			facts.push({ type: 'turn-started', at });
			break;
		case 'phase_changed':
			if (state.turnOpen && typeof row.phase === 'string') state.phase = row.phase;
			break;
		case 'permission_requested':
			if (typeof row.tool_name === 'string') state.waitingFor = row.tool_name;
			break;
		case 'permission_resolved':
			if (state.phase === 'permission_prompt') state.phase = 'tool_execution';
			break;
		case 'tool_started': {
			if (typeof row.tool_name !== 'string') break;
			state.openTools.push(row.tool_name);
			state.activityOpen = true;
			facts.push({ type: 'tool-started', id: row.tool_name, name: row.tool_name, startedAt: at });
			break;
		}
		case 'tool_completed': {
			if (typeof row.tool_name !== 'string') break;
			const i = state.openTools.indexOf(row.tool_name);
			if (i >= 0) state.openTools.splice(i, 1);
			facts.push({ type: 'tool-finished', id: row.tool_name, at });
			break;
		}
		case 'turn_ended': {
			const outcome =
				(typeof row.outcome === 'string' ? OUTCOMES[row.outcome] : undefined) ?? 'completed';
			state.turnOpen = false;
			delete state.phase;
			state.openTools = [];
			state.activityOpen = false;
			facts.push({ type: 'turn-ended', outcome, endedAt: at });
			break;
		}
		default:
			return [];
	}
	if (!state.turnOpen && state.activityOpen) {
		facts.push(closeOpenTurn(state.openTools.length > 0, at));
		state.openTools = [];
		state.activityOpen = false;
	}
	return facts;
}
