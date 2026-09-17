import { systemClock } from '../helpers/clock.ts';
import { createLocalFs } from '../helpers/fs.ts';
import { createLocalProcesses } from '../helpers/processes.ts';
import { tailJsonl } from '../helpers/tail-jsonl.ts';
import type { Processes } from '../helpers/types.ts';
import { watchDir } from '../helpers/watch-dir.ts';
import { watchFile } from '../helpers/watch-file.ts';
import type {
	InspectContext,
	InstanceOptions,
	ListContext,
	Provider,
	ProviderEmit,
	SessionInput,
	Unwatch,
	WatchContext,
} from '../provider.ts';
import type {
	EventMeta,
	ProviderError,
	Session,
	SessionActivity,
	SessionEvent,
	SessionFilter,
	SessionKind,
	SessionSnapshot,
	SessionStatus,
	Subagent,
	SubagentFacts,
	SubagentStatus,
	TitleSource,
	Turn,
	TurnFact,
} from '../types.ts';
import { activityChanged, emptyActivity, reduceActivity, withOpenSubagents } from './activity.ts';
import { groupTurns } from './turns.ts';

const TITLE_ORDER: TitleSource[] = ['user', 'harness', 'process', 'prompt'];

type Listener = (...args: never[]) => void;

type LiveEntry = {
	id: string;
	harness: Session['harness'];
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
	activity: SessionActivity;
	opened: boolean;
};

type SubRecord = Omit<Subagent, 'transcript' | 'events'>;

export type AllYourAgents = {
	on(
		event:
			| 'session:create'
			| 'session:open'
			| 'session:status'
			| 'session:update'
			| 'session:close',
		listener: (session: Session, meta: EventMeta) => void,
	): AllYourAgents;
	on(
		event: 'session:activity',
		listener: (session: Session, meta: EventMeta) => void,
	): AllYourAgents;
	on(
		event: 'subagent:start' | 'subagent:end',
		listener: (subagent: Subagent, session: Session, meta: EventMeta) => void,
	): AllYourAgents;
	on(event: 'ready', listener: () => void): AllYourAgents;
	on(event: 'error', listener: (error: ProviderError) => void): AllYourAgents;
	off(event: string, listener: (...args: never[]) => void): AllYourAgents;
	start(): Promise<void>;
	stop(): Promise<void>;
	reconcile(pid?: number): Promise<void>;
	running(): Session[];
	sessions(filter?: SessionFilter): Promise<Session[]>;
	get(id: string): Promise<Session | undefined>;
};

export function createAllYourAgents(opts: InstanceOptions = {}): AllYourAgents {
	const providers = opts.providers ?? [];
	const fs = opts.fs ?? createLocalFs();
	const createdProcesses = opts.processes ? null : createLocalProcesses();
	const processes = opts.processes ?? createdProcesses;
	const quietMs = opts.debounce?.quietMs ?? 25;
	const maxLatencyMs = opts.debounce?.maxLatencyMs ?? 1000;
	const clock = opts.debounce?.clock ?? systemClock;

	const listeners = new Map<string, Set<Listener>>();
	const live = new Map<string, LiveEntry>();
	const history = new Map<string, LiveEntry>();
	const titles = new Map<string, Partial<Record<TitleSource, string>>>();
	const subagents = new Map<string, Map<string, SubRecord>>();
	const unwatches: Unwatch[] = [];

	let started = false;
	let startPromise: Promise<void> | undefined;
	let catchingUp = false;
	let closed = false;

	const emit = (event: string, ...args: unknown[]): void => {
		if (closed && event !== 'error') return;
		for (const fn of [...(listeners.get(event) ?? [])]) {
			(fn as (...a: unknown[]) => void)(...args);
		}
	};

	const meta = (): EventMeta => ({ catchUp: catchingUp });

	const attachSession = (entry: LiveEntry): Session => {
		const activity: SessionActivity = { openSubagents: entry.activity.openSubagents };
		if (entry.activity.tool) activity.tool = { ...entry.activity.tool };
		if (entry.activity.lastTurn) activity.lastTurn = entry.activity.lastTurn;
		if (entry.activity.lastTurnEndedAt != null)
			activity.lastTurnEndedAt = entry.activity.lastTurnEndedAt;
		if (entry.activity.error) activity.error = entry.activity.error;
		const session: Session = {
			id: entry.id,
			harness: entry.harness,
			provider: entry.provider,
			activity,
			transcript: () => transcriptFor(entry.id),
			events: () => eventsFor(entry.id),
			subagents: () => subagentsFor(entry.id),
		};
		if (entry.pid != null) session.pid = entry.pid;
		if (entry.cwd != null) session.cwd = entry.cwd;
		if (entry.title != null) session.title = entry.title;
		if (entry.status != null) session.status = entry.status;
		if (entry.status === 'waiting' && entry.waitingFor != null)
			session.waitingFor = entry.waitingFor;
		if (entry.startedAt != null) session.startedAt = entry.startedAt;
		if (entry.updatedAt != null) session.updatedAt = entry.updatedAt;
		if (entry.kind != null) session.kind = entry.kind;
		if (entry.model != null) session.model = entry.model;
		return session;
	};

	const attachSub = (rec: SubRecord): Subagent => ({
		...rec,
		transcript: () => transcriptFor(rec.sessionId, rec.id),
		events: () => eventsFor(rec.sessionId, rec.id),
	});

	const countOpen = (sessionId: string): number => {
		let n = 0;
		for (const rec of subagents.get(sessionId)?.values() ?? []) {
			if (rec.status === 'running') n++;
		}
		return n;
	};

	const bumpOpen = (entry: LiveEntry): void => {
		const next = withOpenSubagents(entry.activity, countOpen(entry.id));
		if (activityChanged(entry.activity, next)) {
			entry.activity = next;
			emit('session:activity', attachSession(entry), meta());
		} else {
			entry.activity = next;
		}
	};

	const effectiveTitle = (id: string): string | undefined => {
		const slots = titles.get(id);
		if (!slots) return undefined;
		for (const source of TITLE_ORDER) {
			const value = slots[source];
			if (value) return value;
		}
		return undefined;
	};

	const ensureLive = (input: SessionInput, verb: 'create' | 'open'): LiveEntry | undefined => {
		if (live.has(input.id)) return live.get(input.id);
		const entry: LiveEntry = {
			id: input.id,
			harness: input.harness,
			provider: input.provider,
			activity: emptyActivity(),
			opened: true,
		};
		if (input.pid != null) entry.pid = input.pid;
		if (input.cwd != null) entry.cwd = input.cwd;
		if (input.startedAt != null) entry.startedAt = input.startedAt;
		if (input.updatedAt != null) entry.updatedAt = input.updatedAt;
		if (input.kind != null) entry.kind = input.kind;
		if (input.model != null) entry.model = input.model;
		if (input.title) {
			const slots = titles.get(input.id) ?? {};
			if (!slots.prompt && !slots.process && !slots.harness && !slots.user) {
				slots.process = input.title;
				titles.set(input.id, slots);
			}
		}
		const title = effectiveTitle(input.id) ?? input.title;
		if (title) entry.title = title;
		live.set(input.id, entry);
		history.delete(input.id);
		emit(verb === 'create' ? 'session:create' : 'session:open', attachSession(entry), meta());
		if (input.status) {
			applyStatus(entry, input.status, input.waitingFor, input.updatedAt);
		}
		return entry;
	};

	const applyStatus = (
		entry: LiveEntry,
		status: SessionStatus | undefined,
		waitingFor?: string,
		updatedAt?: number,
	): void => {
		if (status === entry.status && (status !== 'waiting' || waitingFor === entry.waitingFor)) {
			return;
		}
		if (status) entry.status = status;
		else delete entry.status;
		if (status === 'waiting' && waitingFor) entry.waitingFor = waitingFor;
		else delete entry.waitingFor;
		if (updatedAt != null) entry.updatedAt = updatedAt;
		emit('session:status', attachSession(entry), meta());
	};

	const closeSession = (id: string): void => {
		const entry = live.get(id);
		if (!entry) return;
		const kids = subagents.get(id);
		if (kids) {
			for (const rec of kids.values()) {
				if (rec.status !== 'running') continue;
				rec.status = 'cancelled';
				rec.endedAt = clock.now();
				emit('subagent:end', attachSub(rec), attachSession(entry), meta());
			}
		}
		bumpOpen(entry);
		delete entry.pid;
		delete entry.status;
		delete entry.waitingFor;
		live.delete(id);
		history.set(id, entry);
		emit('session:close', attachSession(entry), meta());
	};

	const applyTurn = (entry: LiveEntry, fact: TurnFact, silent: boolean): void => {
		const next = reduceActivity(entry.activity, fact);
		next.openSubagents = countOpen(entry.id);
		if (!activityChanged(entry.activity, next)) {
			entry.activity = next;
			return;
		}
		entry.activity = next;
		if (!silent) emit('session:activity', attachSession(entry), meta());
	};

	const providerEmit: ProviderEmit = ((event, payload) => {
		if (closed) return;
		if (event === 'session:create' || event === 'session:open') {
			const input = payload as SessionInput;
			ensureLive(input, event === 'session:create' ? 'create' : 'open');
			return;
		}
		if (event === 'session:status') {
			const p = payload as {
				id: string;
				status?: SessionStatus;
				waitingFor?: string;
				updatedAt?: number;
			};
			const entry = live.get(p.id);
			if (!entry) return;
			applyStatus(entry, p.status, p.waitingFor, p.updatedAt);
			return;
		}
		if (event === 'session:update') {
			const p = payload as { id: string; cwd?: string; model?: string; updatedAt?: number };
			const entry = live.get(p.id);
			if (!entry) return;
			let changed = false;
			if (p.cwd != null && p.cwd !== entry.cwd) {
				entry.cwd = p.cwd;
				changed = true;
			}
			if (p.model != null && p.model !== entry.model) {
				entry.model = p.model;
				changed = true;
			}
			if (p.updatedAt != null) entry.updatedAt = p.updatedAt;
			if (changed) emit('session:update', attachSession(entry), meta());
			return;
		}
		if (event === 'session:close') {
			closeSession((payload as { id: string }).id);
			return;
		}
		if (event === 'title') {
			const p = payload as { id: string; title: string; source: TitleSource };
			const slots = titles.get(p.id) ?? {};
			slots[p.source] = p.title;
			titles.set(p.id, slots);
			const entry = live.get(p.id);
			if (!entry) return;
			const next = effectiveTitle(p.id);
			if (next !== entry.title) {
				if (next) entry.title = next;
				else delete entry.title;
				emit('session:update', attachSession(entry), meta());
			}
			return;
		}
		if (event === 'turn') {
			const p = payload as { sessionId: string } & TurnFact;
			const entry = live.get(p.sessionId);
			if (!entry) return;
			applyTurn(entry, p, false);
			return;
		}
		if (event === 'activity:replay') {
			const p = payload as { id: string; facts: TurnFact[] };
			const entry = live.get(p.id);
			if (!entry) return;
			let current = emptyActivity();
			current.openSubagents = countOpen(p.id);
			for (const fact of p.facts) current = reduceActivity(current, fact);
			current.openSubagents = countOpen(p.id);
			if (activityChanged(entry.activity, current)) {
				entry.activity = current;
				emit('session:activity', attachSession(entry), meta());
			} else {
				entry.activity = current;
			}
			return;
		}
		if (event === 'subagent:start') {
			const p = payload as SubagentFacts;
			const entry = live.get(p.sessionId);
			if (!entry) return;
			const bag = subagents.get(p.sessionId) ?? new Map();
			subagents.set(p.sessionId, bag);
			if (bag.has(p.id)) return;
			const rec: SubRecord = {
				id: p.id,
				sessionId: p.sessionId,
				harness: p.harness,
				type: p.type,
				background: p.background,
				status: p.status ?? 'running',
			};
			if (p.parentId) rec.parentId = p.parentId;
			if (p.title) rec.title = p.title;
			if (p.startedAt != null) rec.startedAt = p.startedAt;
			if (p.endedAt != null) rec.endedAt = p.endedAt;
			bag.set(p.id, rec);
			if (rec.status === 'running') {
				emit('subagent:start', attachSub(rec), attachSession(entry), meta());
				bumpOpen(entry);
			}
			return;
		}
		if (event === 'subagent:end') {
			const p = payload as {
				sessionId: string;
				id: string;
				status: Exclude<SubagentStatus, 'running'>;
				endedAt?: number;
			};
			const entry = live.get(p.sessionId);
			const bag = subagents.get(p.sessionId);
			const rec = bag?.get(p.id);
			if (!entry || !rec || rec.status !== 'running') return;
			rec.status = p.status;
			rec.endedAt = p.endedAt ?? clock.now();
			emit('subagent:end', attachSub(rec), attachSession(entry), meta());
			bumpOpen(entry);
			return;
		}
		if (event === 'subagent:seed') {
			const p = payload as SubagentFacts;
			const bag = subagents.get(p.sessionId) ?? new Map();
			subagents.set(p.sessionId, bag);
			if (bag.has(p.id)) return;
			const rec: SubRecord = {
				id: p.id,
				sessionId: p.sessionId,
				harness: p.harness,
				type: p.type,
				background: p.background,
				status: p.status ?? 'completed',
			};
			if (p.parentId) rec.parentId = p.parentId;
			if (p.title) rec.title = p.title;
			if (p.startedAt != null) rec.startedAt = p.startedAt;
			if (p.endedAt != null) rec.endedAt = p.endedAt;
			bag.set(p.id, rec);
			const entry = live.get(p.sessionId);
			if (entry) bumpOpen(entry);
		}
	}) as ProviderEmit;

	const makeWatchCtx = (): WatchContext => ({
		emit: providerEmit,
		fs,
		processes: processes as Processes,
		debounce: { quietMs, maxLatencyMs },
		watchDir: (path, onChange) => watchDir(fs, path, onChange, { quietMs, maxLatencyMs, clock }),
		watchFile: (path, onChange) => watchFile(fs, path, onChange, { quietMs, maxLatencyMs, clock }),
		tailJsonl: (path) => tailJsonl(fs, path, { quietMs, maxLatencyMs, clock }),
		processInfo: (pid) => (processes as Processes).info(pid),
		watchProcess: (pid, onExit) => (processes as Processes).watch(pid, onExit),
	});

	const makeListCtx = (filter?: SessionFilter, id?: string): ListContext => ({
		fs,
		since: filter?.since,
		id,
	});

	const makeInspectCtx = (follow: boolean, subagentId?: string): InspectContext => ({
		fs,
		follow,
		subagentId,
	});

	async function* transcriptFor(id: string, subagentId?: string): AsyncIterable<Turn> {
		const events = await collectEvents(id, subagentId, false);
		for (const turn of groupTurns(events)) yield turn;
	}

	async function* eventsFor(id: string, subagentId?: string): AsyncIterable<SessionEvent> {
		for await (const event of iterateEvents(id, subagentId, true)) yield event;
	}

	async function collectEvents(
		id: string,
		subagentId: string | undefined,
		follow: boolean,
	): Promise<SessionEvent[]> {
		const out: SessionEvent[] = [];
		for await (const event of iterateEvents(id, subagentId, follow)) out.push(event);
		return out;
	}

	async function* iterateEvents(
		id: string,
		subagentId: string | undefined,
		follow: boolean,
	): AsyncIterable<SessionEvent> {
		const entry = live.get(id) ?? history.get(id);
		const provider = providers.find((p) => p.id === entry?.provider) ?? providers[0];
		if (!provider?.inspect) return;
		for await (const event of provider.inspect(makeInspectCtx(follow, subagentId), id)) {
			yield event;
		}
	}

	async function subagentsFor(id: string): Promise<Subagent[]> {
		const bag = subagents.get(id);
		if (bag && bag.size > 0) return [...bag.values()].map(attachSub);
		const entry = live.get(id) ?? history.get(id);
		const provider = providers.find((p) => p.id === entry?.provider) ?? providers[0];
		if (!provider?.subagents) return [];
		const facts = await provider.subagents(makeInspectCtx(false), id);
		return facts.map((f) =>
			attachSub({
				id: f.id,
				sessionId: f.sessionId,
				parentId: f.parentId,
				harness: f.harness,
				type: f.type,
				title: f.title,
				background: f.background,
				status: f.status ?? 'completed',
				startedAt: f.startedAt,
				endedAt: f.endedAt,
			}),
		);
	}

	function matches(session: Session, filter?: SessionFilter): boolean {
		if (!filter) return true;
		if (filter.harness && session.harness !== filter.harness) return false;
		if (filter.cwd && session.cwd !== filter.cwd) return false;
		if (filter.kind && session.kind !== filter.kind) return false;
		if (filter.live === true && !live.has(session.id)) return false;
		if (filter.live === false && live.has(session.id)) return false;
		if (filter.since != null) {
			const ts = session.updatedAt ?? session.startedAt;
			if (ts == null || ts < filter.since) return false;
		}
		return true;
	}

	const api: AllYourAgents = {
		on(event: string, listener: Listener) {
			let set = listeners.get(event);
			if (!set) {
				set = new Set();
				listeners.set(event, set);
			}
			set.add(listener);
			return api;
		},
		off(event: string, listener: Listener) {
			listeners.get(event)?.delete(listener);
			return api;
		},
		async start() {
			if (startPromise) return startPromise;
			closed = false;
			started = true;
			catchingUp = true;
			startPromise = (async () => {
				const ctx = makeWatchCtx();
				await Promise.all(
					providers.map(async (provider) => {
						try {
							const unwatch = await provider.watch(ctx);
							unwatches.push(unwatch);
						} catch (error) {
							emit('error', { provider: provider.id, error } satisfies ProviderError);
						}
					}),
				);
				catchingUp = false;
				emit('ready');
			})();
			return startPromise;
		},
		async stop() {
			if (!started && !startPromise) return;
			closed = true;
			started = false;
			const pending = unwatches.splice(0);
			for (const unwatch of pending) {
				try {
					await unwatch();
				} catch {
					// ignore
				}
			}
			live.clear();
			await createdProcesses?.close();
			startPromise = undefined;
			catchingUp = false;
		},
		async reconcile(pid) {
			if (!started) return;
			const ctx = makeWatchCtx();
			for (const provider of providers) {
				try {
					await provider.revalidate?.(ctx, pid);
				} catch (error) {
					emit('error', { provider: provider.id, error } satisfies ProviderError);
				}
			}
		},
		running() {
			if (!started || closed) return [];
			return [...live.values()].map(attachSession);
		},
		async sessions(filter) {
			const byId = new Map<string, Session>();
			for (const entry of history.values()) {
				const session = attachSession(entry);
				if (matches(session, filter)) byId.set(session.id, session);
			}
			for (const provider of providers) {
				if (!provider.list) continue;
				try {
					for await (const snap of provider.list(
						makeListCtx(filter, filter ? undefined : undefined),
					)) {
						const listed = snapshotToSession(
							snap,
							provider,
							transcriptFor,
							eventsFor,
							subagentsFor,
							live.get(snap.id),
						);
						if (matches(listed, filter)) {
							const existing = byId.get(listed.id);
							if (!existing || live.has(listed.id)) byId.set(listed.id, listed);
							else if (!live.has(listed.id) && !history.has(listed.id)) byId.set(listed.id, listed);
							void existing;
						}
					}
				} catch (error) {
					emit('error', { provider: provider.id, error } satisfies ProviderError);
				}
			}
			for (const entry of live.values()) {
				const session = attachSession(entry);
				if (matches(session, filter)) byId.set(session.id, session);
			}
			if (filter?.live === true) {
				return [...live.values()].map(attachSession).filter((s) => matches(s, filter));
			}
			return [...byId.values()];
		},
		async get(id) {
			const liveHit = live.get(id);
			if (liveHit) return attachSession(liveHit);
			const hist = history.get(id);
			if (hist) return attachSession(hist);
			for (const provider of providers) {
				if (!provider.list) continue;
				try {
					for await (const snap of provider.list(makeListCtx(undefined, id))) {
						if (snap.id === id) {
							return snapshotToSession(
								snap,
								provider,
								transcriptFor,
								eventsFor,
								subagentsFor,
								undefined,
							);
						}
					}
				} catch (error) {
					emit('error', { provider: provider.id, error } satisfies ProviderError);
				}
			}
			return undefined;
		},
	};

	return api;
}

function snapshotToSession(
	snap: SessionSnapshot,
	provider: Provider,
	transcriptFor: (id: string) => AsyncIterable<Turn>,
	eventsFor: (id: string) => AsyncIterable<SessionEvent>,
	subagentsFor: (id: string) => Promise<Subagent[]>,
	live: LiveEntry | undefined,
): Session {
	if (live) {
		return {
			id: live.id,
			harness: live.harness,
			provider: live.provider,
			activity: live.activity,
			pid: live.pid,
			cwd: live.cwd,
			title: live.title,
			status: live.status,
			waitingFor: live.status === 'waiting' ? live.waitingFor : undefined,
			startedAt: live.startedAt,
			updatedAt: live.updatedAt,
			kind: live.kind,
			model: live.model,
			transcript: () => transcriptFor(live.id),
			events: () => eventsFor(live.id),
			subagents: () => subagentsFor(live.id),
		};
	}
	const session: Session = {
		id: snap.id,
		harness: snap.harness,
		provider: snap.provider ?? provider.id,
		activity: emptyActivity(),
		transcript: () => transcriptFor(snap.id),
		events: () => eventsFor(snap.id),
		subagents: () => subagentsFor(snap.id),
	};
	if (snap.cwd) session.cwd = snap.cwd;
	if (snap.title) session.title = snap.title;
	if (snap.startedAt != null) session.startedAt = snap.startedAt;
	if (snap.updatedAt != null) session.updatedAt = snap.updatedAt;
	if (snap.kind) session.kind = snap.kind;
	if (snap.model) session.model = snap.model;
	return session;
}
