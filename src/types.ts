export type Harness = 'ClaudeCode' | 'Codex' | 'Grok' | 'OpenCode' | (string & {});

export type SessionStatus = 'running' | 'waiting' | 'idle';

export type SessionKind = 'interactive' | 'headless';

export type TitleSource = 'user' | 'harness' | 'process' | 'prompt';

export type SubagentStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export type TurnOutcome = 'completed' | 'failed' | 'interrupted' | 'open';

export type EventMeta = {
	catchUp: boolean;
};

export type SessionActivity = {
	tool?: {
		id: string;
		name: string;
		startedAt?: number;
	};
	lastTurn?: 'completed' | 'failed' | 'interrupted';
	lastTurnEndedAt?: number;
	error?: string;
	openSubagents: number;
};

export type SessionFilter = {
	harness?: Harness;
	cwd?: string;
	live?: boolean;
	kind?: SessionKind;
	since?: number;
};

export type SessionSnapshot = {
	id: string;
	harness: Harness;
	provider: string;
	cwd?: string;
	title?: string;
	startedAt?: number;
	updatedAt?: number;
	kind?: SessionKind;
	model?: string;
};

export type Session = SessionSnapshot & {
	activity: SessionActivity;
	pid?: number;
	status?: SessionStatus;
	waitingFor?: string;
	transcript(): AsyncIterable<Turn>;
	events(): AsyncIterable<SessionEvent>;
	subagents(): Promise<Subagent[]>;
};

export type Subagent = {
	id: string;
	sessionId: string;
	parentId?: string;
	harness: Harness;
	type: string;
	title?: string;
	background: boolean;
	status: SubagentStatus;
	startedAt?: number;
	endedAt?: number;
	transcript(): AsyncIterable<Turn>;
	events(): AsyncIterable<SessionEvent>;
};

export type SessionEvent =
	| { kind: 'user'; text: string; raw: unknown; at?: number }
	| { kind: 'assistant'; text: string; model?: string; raw: unknown; at?: number }
	| { kind: 'tool'; id: string; name: string; raw: unknown; at?: number }
	| { kind: 'tool-result'; id: string; isError?: boolean; raw: unknown; at?: number }
	| {
			kind: 'title';
			title: string;
			source: Exclude<TitleSource, 'process'>;
			raw: unknown;
			at?: number;
	  }
	| { kind: 'turn-end'; outcome?: Exclude<TurnOutcome, 'open'>; raw: unknown; at?: number }
	| {
			kind: 'subagent';
			id: string;
			title?: string;
			type?: string;
			background?: boolean;
			raw: unknown;
			at?: number;
	  }
	| {
			kind: 'subagent-end';
			id: string;
			status: Exclude<SubagentStatus, 'running'>;
			raw: unknown;
			at?: number;
	  }
	| { kind: 'error'; message: string; raw: unknown; at?: number }
	| { kind: 'other'; raw: unknown; at?: number };

export type Turn = {
	events: SessionEvent[];
	startedAt?: number;
	endedAt?: number;
	outcome: TurnOutcome;
};

export type TurnFact =
	| { type: 'turn-started'; at?: number }
	| { type: 'tool-started'; id: string; name: string; startedAt?: number }
	| { type: 'tool-finished'; id: string; at?: number }
	| {
			type: 'turn-ended';
			outcome: Exclude<TurnOutcome, 'open'>;
			error?: string;
			endedAt?: number;
	  };

export type SubagentFacts = {
	id: string;
	sessionId: string;
	parentId?: string;
	harness: Harness;
	type: string;
	title?: string;
	background: boolean;
	status?: SubagentStatus;
	startedAt?: number;
	endedAt?: number;
};

/**
 * Payload of the `error` event. A provider failed, or a listener threw while handling
 * `event`. Neither is ever thrown into the caller.
 */
export type AgentsError =
	| { source: 'provider'; provider: string; error: unknown }
	| { source: 'listener'; event: string; error: unknown };
