import type { SessionStatus, TurnFact } from '../../types.ts';
import { type CollabHint, parseCollabItem } from './subagents.ts';

export type EventsState = {
	turnOpen: boolean;
	/** When the open turn started, if its record had a timestamp. */
	turnStartedAt?: number;
	activityOpen: boolean;
	openTools: string[];
	model?: string;
	cwd?: string;
	collab: CollabHint[];
};

export function initialEventsState(): EventsState {
	return { turnOpen: false, activityOpen: false, openTools: [], collab: [] };
}

export function recordTime(rec: Record<string, unknown>): number | undefined {
	const ts = rec.timestamp;
	if (typeof ts !== 'string') return undefined;
	const n = Date.parse(ts);
	return Number.isFinite(n) ? n : undefined;
}

export function envelope(
	rec: unknown,
): { type: string; payload: Record<string, unknown>; at?: number } | undefined {
	if (!rec || typeof rec !== 'object') return undefined;
	const row = rec as Record<string, unknown>;
	if (typeof row.type !== 'string') return undefined;
	const payload =
		row.payload && typeof row.payload === 'object' ? (row.payload as Record<string, unknown>) : row;
	return { type: row.type, payload, at: recordTime(row) };
}

export function eventMsgType(payload: Record<string, unknown>): string | undefined {
	return typeof payload.type === 'string' ? payload.type : undefined;
}

export function deriveStatus(state: EventsState): { status?: SessionStatus } {
	return { status: state.turnOpen ? 'running' : 'idle' };
}

const TOOL_CALLS = new Set([
	'function_call',
	'custom_tool_call',
	'local_shell_call',
	'web_search_call',
	'image_generation_call',
]);
const TOOL_OUTPUTS = new Set(['function_call_output', 'custom_tool_call_output']);

function callIdOf(payload: Record<string, unknown>): string | undefined {
	if (typeof payload.call_id === 'string' && payload.call_id) return payload.call_id;
	if (typeof payload.id === 'string' && payload.id) return payload.id;
	return undefined;
}

function toolNameOf(payload: Record<string, unknown>): string {
	if (typeof payload.name === 'string' && payload.name) return payload.name;
	if (payload.type === 'local_shell_call') return 'local_shell';
	if (payload.type === 'web_search_call') return 'web_search';
	if (payload.type === 'image_generation_call') return 'image_generation';
	return 'exec';
}

function errorMessage(payload: Record<string, unknown>): string | undefined {
	const error = payload.error;
	if (!error) return undefined;
	if (typeof error === 'string') return error;
	if (typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
		return (error as { message: string }).message;
	}
	return undefined;
}

function settingsModel(payload: Record<string, unknown>): string | undefined {
	const settings = payload.thread_settings;
	if (settings && typeof settings === 'object') {
		const model = (settings as { model?: unknown }).model;
		if (typeof model === 'string' && model) return model;
	}
	if (typeof payload.model === 'string' && payload.model) return payload.model;
	return undefined;
}

function settingsCwd(payload: Record<string, unknown>): string | undefined {
	const settings = payload.thread_settings;
	if (settings && typeof settings === 'object') {
		const cwd = (settings as { cwd?: unknown }).cwd;
		if (typeof cwd === 'string' && cwd) return cwd;
	}
	if (typeof payload.cwd === 'string' && payload.cwd) return payload.cwd;
	return undefined;
}

/**
 * Apply one rollout record. Lifecycle `event_msg` starts/ends turns; `response_item`
 * tool calls start/finish tools. `item_completed` never starts or finishes a tool.
 */
/**
 * A turn left open by a process that was killed or crashed never gets its end record. If
 * replay leaves open a turn that started before the process now holding the thread, that
 * turn is over: end it as interrupted at the process start.
 */
export function endStaleTurn(state: EventsState, processStart: number | undefined): TurnFact[] {
	if (!state.turnOpen || processStart == null || state.turnStartedAt == null) return [];
	if (state.turnStartedAt >= processStart) return [];
	state.turnOpen = false;
	state.openTools = [];
	state.activityOpen = false;
	return [{ type: 'turn-ended', outcome: 'interrupted', endedAt: processStart }];
}

export function reduceRecord(state: EventsState, rec: unknown): TurnFact[] {
	const env = envelope(rec);
	if (!env) return [];
	const { type, payload, at } = env;
	if (type === 'event_msg') {
		const kind = eventMsgType(payload);
		if (kind === 'task_started' || kind === 'turn_started') {
			state.turnOpen = true;
			state.turnStartedAt = at;
			state.activityOpen = true;
			state.openTools = [];
			return [{ type: 'turn-started', at }];
		}
		if (kind === 'task_complete' || kind === 'turn_complete') {
			const error = errorMessage(payload);
			state.turnOpen = false;
			state.openTools = [];
			state.activityOpen = false;
			return [
				{
					type: 'turn-ended',
					outcome: error ? 'failed' : 'completed',
					error,
					endedAt: at,
				},
			];
		}
		if (kind === 'turn_aborted') {
			state.turnOpen = false;
			state.openTools = [];
			state.activityOpen = false;
			return [{ type: 'turn-ended', outcome: 'interrupted', endedAt: at }];
		}
		if (kind === 'thread_settings_applied') {
			const model = settingsModel(payload);
			if (model) state.model = model;
			const cwd = settingsCwd(payload);
			if (cwd) state.cwd = cwd;
			return [];
		}
		if (kind === 'item_completed') {
			const hint = parseCollabItem(payload.item);
			if (hint) state.collab.push(hint);
			return [];
		}
		return [];
	}
	if (type === 'turn_context') {
		const model = settingsModel(payload);
		if (model) state.model = model;
		const cwd = settingsCwd(payload);
		if (cwd) state.cwd = cwd;
		return [];
	}
	if (type !== 'response_item') return [];
	const itemType = typeof payload.type === 'string' ? payload.type : undefined;
	if (itemType && TOOL_CALLS.has(itemType)) {
		const id = callIdOf(payload) ?? toolNameOf(payload);
		const name = toolNameOf(payload);
		state.openTools.push(id);
		state.activityOpen = true;
		return [{ type: 'tool-started', id, name, startedAt: at }];
	}
	if (itemType && TOOL_OUTPUTS.has(itemType)) {
		const id = callIdOf(payload);
		if (!id) return [];
		const i = state.openTools.indexOf(id);
		if (i >= 0) state.openTools.splice(i, 1);
		return [{ type: 'tool-finished', id, at }];
	}
	return [];
}
