import type {
	DebounceOptions,
	DirChange,
	FileChange,
	Fs,
	Processes,
	ProcessInfo,
} from './helpers/types.ts';
import type {
	Harness,
	SessionEvent,
	SessionKind,
	SessionSnapshot,
	SessionStatus,
	SubagentFacts,
	SubagentStatus,
	TitleSource,
	TurnFact,
} from './types.ts';

export type SessionInput = {
	id: string;
	harness: Harness;
	provider: string;
	pid?: number;
	cwd?: string;
	title?: string;
	status?: SessionStatus;
	waitingFor?: string;
	startedAt?: number;
	updatedAt?: number;
	kind?: SessionKind;
	model?: string;
};

export type ProviderEmit = {
	(event: 'session:create' | 'session:open', session: SessionInput): void;
	(
		event: 'session:status',
		session: { id: string; status?: SessionStatus; waitingFor?: string; updatedAt?: number },
	): void;
	(
		event: 'session:update',
		session: { id: string; cwd?: string; model?: string; updatedAt?: number },
	): void;
	(event: 'session:close', session: { id: string }): void;
	(event: 'title', payload: { id: string; title: string; source: TitleSource }): void;
	(event: 'turn', payload: { sessionId: string } & TurnFact): void;
	(event: 'activity:replay', payload: { id: string; facts: TurnFact[] }): void;
	(event: 'subagent:start', payload: SubagentFacts): void;
	(
		event: 'subagent:end',
		payload: {
			sessionId: string;
			id: string;
			status: Exclude<SubagentStatus, 'running'>;
			endedAt?: number;
		},
	): void;
	(event: 'subagent:seed', payload: SubagentFacts): void;
};

export type Unwatch = () => void | Promise<void>;

export type WatchDirFn = (
	path: string,
	onChange: (event: DirChange) => void,
) => { close(): void; ready?: Promise<void> };

export type WatchFileFn = (
	path: string,
	onChange: (event: FileChange) => void,
) => { close(): void };

export type TailJsonlFn = (path: string) => AsyncIterable<unknown> & { close(): void };

export type WatchContext = {
	emit: ProviderEmit;
	home?: string;
	fs: Fs;
	processes: Processes;
	debounce: { quietMs: number; maxLatencyMs: number };
	watchDir: WatchDirFn;
	watchFile: WatchFileFn;
	tailJsonl: TailJsonlFn;
	processInfo: (pid: number) => Promise<ProcessInfo>;
	watchProcess: Processes['watch'];
};

export type ListContext = {
	fs: Fs;
	since?: number;
	id?: string;
	home?: string;
};

export type InspectContext = {
	fs: Fs;
	follow?: boolean;
	subagentId?: string;
	home?: string;
};

export type Provider = {
	id: string;
	harness: Harness;
	watch(ctx: WatchContext): Promise<Unwatch> | Unwatch;
	list?(ctx: ListContext): AsyncIterable<SessionSnapshot>;
	inspect?(ctx: InspectContext, id: string): AsyncIterable<SessionEvent>;
	revalidate?(ctx: WatchContext, pid?: number): Promise<void> | void;
	subagents?(ctx: InspectContext, sessionId: string): Promise<SubagentFacts[]>;
};

export type InstanceOptions = {
	providers?: Provider[];
	fs?: Fs;
	processes?: Processes;
	debounce?: DebounceOptions;
};
