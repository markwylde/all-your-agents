import type { SessionStatus, SubagentStatus, TitleSource, TurnFact } from '../../types.ts';

export type OpenTool = { id: string; name: string; executing: boolean };

export type EventsState = {
	turnOpen: boolean;
	/** When the open turn started, if its record had a timestamp. */
	turnStartedAt?: number;
	/** Timestamp of the newest entry seen. */
	lastAt?: number;
	/**
	 * The open turn was started by a prompt seen in omp's prompt history, before the
	 * transcript existed. Its user message, when it arrives, is that same prompt.
	 */
	awaitingPrompt: boolean;
	openTools: OpenTool[];
	model?: string;
};

export function initialEventsState(): EventsState {
	return { turnOpen: false, awaitingPrompt: false, openTools: [] };
}

export type Entry = {
	type: string;
	row: Record<string, unknown>;
	message?: Record<string, unknown>;
	at?: number;
};

export function entryOf(rec: unknown): Entry | undefined {
	if (!rec || typeof rec !== 'object') return undefined;
	const row = rec as Record<string, unknown>;
	if (typeof row.type !== 'string') return undefined;
	const entry: Entry = { type: row.type, row };
	if (row.message && typeof row.message === 'object') {
		entry.message = row.message as Record<string, unknown>;
	}
	const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : Number.NaN;
	if (Number.isFinite(at)) entry.at = at;
	return entry;
}

type Block = Record<string, unknown>;

export function blocksOf(message: Record<string, unknown>): Block[] {
	const content = message.content;
	if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
	if (!Array.isArray(content)) return [];
	return content.filter((b): b is Block => Boolean(b) && typeof b === 'object');
}

export function textOf(message: Record<string, unknown>): string {
	return blocksOf(message)
		.filter((b) => b.type === 'text' && typeof b.text === 'string')
		.map((b) => b.text as string)
		.join('\n')
		.trim();
}

/** The prompt a user typed. Injected roles (`developer`, `fileMention`) are not prompts. */
export function userTextOf(entry: Entry): string | undefined {
	if (entry.type !== 'message' || entry.message?.role !== 'user') return undefined;
	return textOf(entry.message) || undefined;
}

export function titleChangeOf(
	entry: Entry,
): { title: string; source: Exclude<TitleSource, 'process' | 'prompt'> } | undefined {
	if (entry.type !== 'title_change') return undefined;
	const title = typeof entry.row.title === 'string' ? entry.row.title.trim() : '';
	if (!title) return undefined;
	return { title, source: entry.row.source === 'user' ? 'user' : 'harness' };
}

export function modelOf(message: Record<string, unknown>): string | undefined {
	const model = typeof message.model === 'string' ? message.model : '';
	if (!model) return undefined;
	const provider = typeof message.provider === 'string' ? message.provider : '';
	return provider ? `${provider}/${model}` : model;
}

export function customOf(
	entry: Entry,
): { kind: string; data: Record<string, unknown> } | undefined {
	if (entry.type !== 'custom' || typeof entry.row.customType !== 'string') return undefined;
	const data = entry.row.data;
	return {
		kind: entry.row.customType,
		data: data && typeof data === 'object' ? (data as Record<string, unknown>) : {},
	};
}

/**
 * `ask` blocks on the user once it is executing. Permission approvals happen before the
 * assistant message is written, so nothing on disk distinguishes them from a slow model.
 */
export function deriveStatus(state: EventsState): { status: SessionStatus; waitingFor?: string } {
	if (!state.turnOpen) return { status: 'idle' };
	if (state.openTools.some((tool) => tool.name === 'ask' && tool.executing)) {
		return { status: 'waiting', waitingFor: 'ask' };
	}
	return { status: 'running' };
}

function endTurn(
	state: EventsState,
	outcome: 'completed' | 'failed' | 'interrupted',
	at: number | undefined,
	error?: string,
): TurnFact[] {
	state.turnOpen = false;
	state.awaitingPrompt = false;
	state.turnStartedAt = undefined;
	state.openTools = [];
	const fact: TurnFact = { type: 'turn-ended', outcome, endedAt: at };
	if (error) fact.error = error;
	return [fact];
}

function startTurn(state: EventsState, at: number | undefined): TurnFact[] {
	if (state.turnOpen) return [];
	state.turnOpen = true;
	state.turnStartedAt = at;
	state.openTools = [];
	return [{ type: 'turn-started', at }];
}

/**
 * A prompt omp recorded in its history before the session had a transcript. It opens the
 * turn; the transcript's first user message is then recognised as this prompt.
 */
export function promptSubmitted(state: EventsState, at: number | undefined): TurnFact[] {
	if (state.turnOpen) return [];
	const facts = startTurn(state, at);
	state.awaitingPrompt = true;
	return facts;
}

/**
 * A turn left open by a process that was killed never gets its end. If replay leaves open
 * a turn whose last sign of life predates the process now on the session, it is over.
 */
export function endStaleTurn(state: EventsState, processStart: number | undefined): TurnFact[] {
	const last = state.lastAt ?? state.turnStartedAt;
	if (!state.turnOpen || processStart == null || last == null) return [];
	if (last >= processStart) return [];
	return endTurn(state, 'interrupted', processStart);
}

/** Apply one transcript entry, in file order. */
export function reduceRecord(state: EventsState, rec: unknown): TurnFact[] {
	const entry = entryOf(rec);
	if (!entry) return [];
	const { at } = entry;
	if (at != null) state.lastAt = at;

	if (entry.type === 'model_change') {
		if (typeof entry.row.model === 'string' && entry.row.model) state.model = entry.row.model;
		return [];
	}

	const custom = customOf(entry);
	if (custom) {
		if (custom.kind === 'tool_execution_start') {
			const tool = state.openTools.find((t) => t.id === custom.data.toolCallId);
			if (tool) tool.executing = true;
			return [];
		}
		// Written on the way out. A turn still open then was cut short.
		if (custom.kind === 'session_exit' && state.turnOpen) return endTurn(state, 'interrupted', at);
		return [];
	}

	if (entry.type !== 'message' || !entry.message) return [];
	const message = entry.message;

	if (message.role === 'user') {
		if (!textOf(message)) return [];
		if (state.turnOpen) {
			// Either the prompt that history already told us about, or one queued mid-turn.
			state.awaitingPrompt = false;
			return [];
		}
		return startTurn(state, at);
	}

	if (message.role === 'toolResult') {
		// omp retries after a provider error without a new prompt: the turn is on again.
		const facts = startTurn(state, at);
		const id = typeof message.toolCallId === 'string' ? message.toolCallId : undefined;
		if (!id) return facts;
		const i = state.openTools.findIndex((tool) => tool.id === id);
		if (i >= 0) state.openTools.splice(i, 1);
		facts.push({ type: 'tool-finished', id, at });
		return facts;
	}

	if (message.role !== 'assistant') return [];
	const model = modelOf(message);
	if (model) state.model = model;
	const facts = startTurn(state, at);
	state.awaitingPrompt = false;
	for (const block of blocksOf(message)) {
		if (block.type !== 'toolCall') continue;
		const name = typeof block.name === 'string' && block.name ? block.name : 'tool';
		const id = typeof block.id === 'string' && block.id ? block.id : name;
		state.openTools.push({ id, name, executing: false });
		facts.push({ type: 'tool-started', id, name, startedAt: at });
	}
	switch (message.stopReason) {
		case 'stop':
		case 'length':
			return [...facts, ...endTurn(state, 'completed', at)];
		case 'error': {
			const error = typeof message.errorMessage === 'string' ? message.errorMessage : undefined;
			return [...facts, ...endTurn(state, 'failed', at, error)];
		}
		case 'aborted':
			return [...facts, ...endTurn(state, 'interrupted', at)];
		default:
			return facts;
	}
}

export function replayRecords(
	records: unknown[],
	state: EventsState = initialEventsState(),
): { state: EventsState; facts: TurnFact[] } {
	const facts: TurnFact[] = [];
	for (const rec of records) facts.push(...reduceRecord(state, rec));
	return { state, facts };
}

/**
 * How a subagent's own transcript says it ended. A subagent hands its result back with the
 * `yield` tool; a reply that merely stops is not the end, because omp then reminds the
 * agent to yield and it carries on. `session_exit` is appended to every child only when the
 * whole process exits, so it means "cut off" and nothing more.
 */
export function childOutcome(
	state: EventsState,
	rec: unknown,
): { status: Exclude<SubagentStatus, 'running'>; at?: number } | undefined {
	const entry = entryOf(rec);
	if (!entry) return undefined;
	const message = entry.message;
	const facts = reduceRecord(state, rec);
	if (entry.type === 'message' && message?.role === 'toolResult' && message.toolName === 'yield') {
		const details = message.details as { status?: unknown } | undefined;
		const ok = details?.status === 'success' && message.isError !== true;
		return { status: ok ? 'completed' : 'failed', at: entry.at };
	}
	if (customOf(entry)?.kind === 'session_exit') return { status: 'cancelled', at: entry.at };
	const ended = facts.find((fact) => fact.type === 'turn-ended');
	if (ended?.type !== 'turn-ended' || ended.outcome === 'completed') return undefined;
	return { status: ended.outcome === 'failed' ? 'failed' : 'cancelled', at: entry.at };
}
