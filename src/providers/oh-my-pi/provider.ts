import { basename, dirname, join } from 'node:path';
import type { ProcessWatchHandle, SqliteRow } from '../../helpers/types.ts';
import type { InspectContext, ListContext, Provider, WatchContext } from '../../provider.ts';
import type { SessionEvent, SessionStatus, SubagentFacts, SubagentStatus } from '../../types.ts';
import { replaySeed } from './activity.ts';
import {
	childOutcome,
	deriveStatus,
	type EventsState,
	entryOf,
	initialEventsState,
	promptSubmitted,
	reduceRecord,
	titleChangeOf,
	userTextOf,
} from './events.ts';
import {
	HISTORY_ROWS,
	type HistoryCursor,
	MAX_ID,
	NEWEST_ROWS,
	seedCursor,
	takeFresh,
} from './history.ts';
import {
	agentTypeOf,
	asyncAgentIds,
	type ChatMapState,
	followRecords,
	mapRecord,
	promptTitle,
	readRecords,
	reportedOutcomes,
} from './journal.ts';
import { findSessionFile, listSessions } from './list.ts';
import {
	artifactDir,
	historyWalPath,
	isProfileName,
	type PathOptions,
	profileDirs,
	profileNames,
	type Root,
	resolveRoot,
	resolveRoots,
} from './paths.ts';
import {
	breadcrumbNameOf,
	isTerminalName,
	type KnownBreadcrumb,
	readBreadcrumb,
	readPresence,
} from './registry.ts';
import { readHead } from './session-file.ts';
import {
	agentIdOf,
	agentTitleOf,
	childFiles,
	NOT_A_DIRECTORY,
	subagentsOnDisk,
} from './subagents.ts';

type Tail = AsyncIterable<unknown> & { close(): void; backlog: Promise<unknown[]> };
type Closer = { close(): void; ready?: Promise<void> };

type Agent = {
	facts: SubagentFacts;
	reported: boolean;
	path: string;
	closes: (() => void)[];
};

type Bound = {
	id: string;
	pid: number;
	root: Root;
	/** The breadcrumb's file name: the terminal this session is on. */
	terminal: string;
	cwd: string;
	path: string;
	/** The transcript exists and is being tailed. omp writes none for the whole first turn. */
	attached: boolean;
	ino?: number;
	events: EventsState;
	processStart?: number;
	status?: SessionStatus;
	waitingFor?: string;
	model?: string;
	promptTitled: boolean;
	/** Children found while binding are seeded, not announced as starting now. */
	seeding: boolean;
	/** When binding began: a child whose header starts later is new, even while seeding. */
	boundAt: number;
	/** Agents a `task` result said it spawned asynchronously: omp's own word for background. */
	asyncAgents: Set<string>;
	/** What parents have said became of their agents, kept for a child we have yet to read. */
	reported: Map<string, Exclude<SubagentStatus, 'running'>>;
	pending: Set<Promise<void>>;
	agents: Map<string, Agent>;
	closes: Map<string, () => void>;
	released: boolean;
};

/** A live omp process, from its presence file, with the terminal it was probed to be on. */
type Client = { pid: number; terminal?: string; startTime?: number };

type RootState = {
	root: Root;
	/** The named profile this root belongs to; the default root has none. */
	profile?: string;
	/** Presence file path → the process it names. */
	clients: Map<string, Client>;
	watches: Map<string, Closer>;
	history?: HistoryCursor;
	historyFailed: boolean;
};

const HARNESS = 'OhMyPi';
const PROVIDER = 'oh-my-pi';
/** A breadcrumb this much older than a process was not written by it. */
const BREADCRUMB_SLACK_MS = 5000;

export function ohMyPi(options: PathOptions = {}): Provider {
	let ctx: WatchContext | undefined;
	let closed = false;
	let processWatchUnsupported = false;
	const roots = new Map<string, RootState>();
	const starting = new Set<Promise<void>>();
	const bounds = new Map<string, Bound>();
	const pidWatches = new Map<number, ProcessWatchHandle | undefined>();
	const stalePids = new Set<number>();
	const profileWatches: Closer[] = [];

	let queue: Promise<void> = Promise.resolve();
	const inOrder = (task: () => Promise<void>): Promise<void> => {
		const next = queue.then(task).catch((error: unknown) => {
			if (!closed) ctx?.reportError(error);
		});
		queue = next;
		return next;
	};
	const drain = async (): Promise<void> => {
		let seen: Promise<void> | undefined;
		while (seen !== queue) {
			seen = queue;
			await seen;
		}
	};

	const boundOn = (state: RootState, terminal: string): Bound | undefined => {
		for (const bound of bounds.values()) {
			if (bound.root === state.root && bound.terminal === terminal) return bound;
		}
		return undefined;
	};

	const boundOf = (pid: number): Bound | undefined => {
		for (const bound of bounds.values()) if (bound.pid === pid) return bound;
		return undefined;
	};

	// ---- subagents -----------------------------------------------------------------------

	const finishAgent = (
		bound: Bound,
		agent: Agent,
		status: Exclude<SubagentStatus, 'running'>,
		endedAt?: number,
	): void => {
		if (agent.facts.status && agent.facts.status !== 'running') return;
		agent.facts.status = status;
		if (endedAt != null) agent.facts.endedAt = endedAt;
		for (const close of agent.closes.splice(0)) close();
		if (agent.reported) {
			ctx?.emit('subagent:end', { sessionId: bound.id, id: agent.facts.id, status, endedAt });
		}
	};

	const reportLive = (bound: Bound, agent: Agent): void => {
		if (agent.reported || bound.released) return;
		agent.reported = true;
		// A quick agent can be over before its file is first read. It still started, then
		// ended: the core announces a start only for a subagent that is running.
		const { endedAt: _endedAt, ...started } = agent.facts;
		ctx?.emit('subagent:start', { ...started, status: 'running' });
		if (agent.facts.status && agent.facts.status !== 'running') {
			ctx?.emit('subagent:end', {
				sessionId: bound.id,
				id: agent.facts.id,
				status: agent.facts.status,
				endedAt: agent.facts.endedAt,
			});
		}
	};

	const seedAgents = (bound: Bound): void => {
		if (!ctx || bound.released) return;
		for (const agent of bound.agents.values()) {
			if (agent.reported) continue;
			agent.reported = true;
			ctx.emit('subagent:seed', agent.facts);
		}
	};

	const consume = (bound: Bound, tail: Tail, handle: (rec: unknown) => void): void => {
		void (async () => {
			try {
				for await (const rec of tail) {
					if (bound.released) break;
					try {
						handle(rec);
					} catch (error) {
						ctx?.reportError(error);
					}
				}
			} catch (error) {
				if (!bound.released) ctx?.reportError(error);
			}
		})();
	};

	/**
	 * The subagent whose transcript a child's header names as its parent. Matched by file
	 * name, not path: omp canonicalises paths (`/tmp` and `/private/tmp`), a breadcrumb may not.
	 */
	const parentIdOf = (bound: Bound, parentSession: string | undefined): string | undefined => {
		if (!parentSession || basename(parentSession) === basename(bound.path)) return undefined;
		const id = agentIdOf(parentSession);
		return bound.agents.has(id) ? id : undefined;
	};

	/** A parent's word on its agents counts too; whichever source speaks first wins. */
	const noteReported = (bound: Bound, rec: unknown, live: boolean): void => {
		for (const { id, status } of reportedOutcomes(rec)) {
			if (!bound.reported.has(id)) bound.reported.set(id, status);
			const agent = bound.agents.get(id);
			if (agent?.facts.status !== 'running') continue;
			if (live) finishAgent(bound, agent, status, entryOf(rec)?.at);
			else agent.facts.status = status;
		}
	};

	const onChild = async (bound: Bound, path: string): Promise<void> => {
		if (!ctx || bound.released) return;
		const id = agentIdOf(path);
		const existing = bound.agents.get(id);
		if (existing) {
			// The session moved and its children with it. A finished one stays finished.
			existing.path = path;
			if (existing.facts.status !== 'running') return;
			for (const close of existing.closes.splice(0)) close();
		}
		const head = await readHead(ctx.fs, path);
		if (!ctx || bound.released) return;
		const agent: Agent = existing ?? {
			facts: {
				id,
				sessionId: bound.id,
				harness: HARNESS,
				type: 'subagent',
				title: agentTitleOf(id),
				background: bound.asyncAgents.has(id),
				status: 'running',
			},
			reported: false,
			path,
			closes: [],
		};
		const parentId = parentIdOf(bound, head?.parentSession);
		if (parentId) agent.facts.parentId = parentId;
		if (head?.startedAt != null) agent.facts.startedAt = head.startedAt;
		bound.agents.set(id, agent);

		const tail = ctx.tailJsonl(path, { backlog: 'separate' });
		agent.closes.push(() => tail.close());
		const state = initialEventsState();
		const apply = (rec: unknown, live: boolean): void => {
			// This child may have spawned agents of its own, and reports on them as any parent does.
			noteReported(bound, rec, live);
			const type = agentTypeOf(rec);
			if (type && agent.facts.type === 'subagent') agent.facts.type = type;
			const outcome = childOutcome(state, rec);
			if (!outcome) return;
			if (live) finishAgent(bound, agent, outcome.status, outcome.at);
			else if (agent.facts.status === 'running') {
				agent.facts.status = outcome.status;
				if (outcome.at != null) agent.facts.endedAt = outcome.at;
			}
		};
		let records: unknown[] = [];
		try {
			records = await tail.backlog;
		} catch (error) {
			if (!bound.released) ctx?.reportError(error);
		}
		if (!ctx || bound.released) return;
		for (const rec of records) apply(rec, false);
		const told = bound.reported.get(id);
		if (told && agent.facts.status === 'running') agent.facts.status = told;
		// A child spawned while we were still binding has not been seen by anyone yet.
		const isNew = head?.startedAt != null && head.startedAt > bound.boundAt;
		if (!bound.seeding || isNew) reportLive(bound, agent);
		if (agent.facts.status !== 'running') {
			for (const close of agent.closes.splice(0)) close();
			return;
		}
		consume(bound, tail, (rec) => apply(rec, true));
	};

	/** Subagent transcripts are `*.jsonl`; tool logs and outputs beside them are not ours. */
	const watchArtifacts = (bound: Bound, dir: string): void => {
		if (!ctx || bound.released || bound.closes.has(`artifacts:${dir}`)) return;
		const handle = ctx.watchDir(dir, (event) => {
			if (closed || bound.released || event.type === 'delete') return;
			const run = (work: Promise<void>): void => {
				const tracked = work
					.catch((error: unknown) => {
						if (!bound.released) ctx?.reportError(error);
					})
					.finally(() => bound.pending.delete(tracked));
				bound.pending.add(tracked);
			};
			if (event.name.endsWith('.jsonl')) {
				if (event.type === 'create') run(onChild(bound, event.path));
				return;
			}
			if (event.type !== 'create' || NOT_A_DIRECTORY.test(event.name)) return;
			// A subagent's own children: `<Parent>/<Parent>.<Child>.jsonl`.
			run(
				(async () => {
					const st = await ctx?.fs.stat(event.path).catch(() => null);
					if (st?.isDirectory) watchArtifacts(bound, event.path);
				})(),
			);
		});
		bound.closes.set(`artifacts:${dir}`, () => handle.close());
		if (handle.ready) {
			const ready = handle.ready.finally(() => bound.pending.delete(ready));
			bound.pending.add(ready);
		}
	};

	const settle = async (bound: Bound): Promise<void> => {
		while (bound.pending.size > 0) await Promise.all([...bound.pending]);
	};

	// ---- one session ---------------------------------------------------------------------

	const applyStatus = (bound: Bound): void => {
		const { status, waitingFor } = deriveStatus(bound.events);
		if (status === bound.status && waitingFor === bound.waitingFor) return;
		bound.status = status;
		bound.waitingFor = waitingFor;
		ctx?.emit(
			'session:status',
			waitingFor ? { id: bound.id, status, waitingFor } : { id: bound.id, status },
		);
	};

	const reportModel = (bound: Bound, model: string | undefined): void => {
		if (!model || model === bound.model) return;
		bound.model = model;
		ctx?.emit('session:update', { id: bound.id, model });
	};

	const reportCwd = (bound: Bound, cwd: string | undefined): void => {
		if (!cwd || cwd === bound.cwd) return;
		bound.cwd = cwd;
		ctx?.emit('session:update', { id: bound.id, cwd });
	};

	const reportPrompt = (bound: Bound, text: string | undefined): void => {
		if (bound.promptTitled || !text) return;
		bound.promptTitled = true;
		ctx?.emit('title', { id: bound.id, title: promptTitle(text), source: 'prompt' });
	};

	const reportTitles = (bound: Bound, rec: unknown): void => {
		const entry = entryOf(rec);
		if (!entry) return;
		reportPrompt(bound, userTextOf(entry));
		const titled = titleChangeOf(entry);
		if (titled) ctx?.emit('title', { id: bound.id, title: titled.title, source: titled.source });
	};

	/** A child still open when the root's turn is over is running in the background. */
	const markBackground = (bound: Bound): void => {
		if (bound.events.turnOpen) return;
		for (const agent of bound.agents.values()) {
			if (agent.facts.status === 'running') agent.facts.background = true;
		}
	};

	const noteAsyncAgents = (bound: Bound, rec: unknown): void => {
		for (const id of asyncAgentIds(rec)) bound.asyncAgents.add(id);
	};

	const handleRecord = (bound: Bound, rec: unknown): void => {
		if (!ctx) return;
		reportTitles(bound, rec);
		noteAsyncAgents(bound, rec);
		noteReported(bound, rec, true);
		const facts = reduceRecord(bound.events, rec);
		reportModel(bound, bound.events.model);
		for (const fact of facts) ctx.emit('turn', { sessionId: bound.id, ...fact });
		applyStatus(bound);
		markBackground(bound);
	};

	/**
	 * `seed`: the transcript predates us, so what it holds is replayed silently. `live`: we
	 * bound this session before it had a transcript, so everything in it happened on our
	 * watch, and a turn already opened from the prompt history continues through it.
	 */
	const attach = async (bound: Bound, mode: 'seed' | 'live'): Promise<void> => {
		if (!ctx || bound.released) return;
		bound.closes.get('tail')?.();
		const path = bound.path;
		const st = await ctx.fs.stat(path).catch(() => null);
		if (!ctx || bound.released || bound.path !== path || !st?.isFile) return;
		bound.attached = true;
		bound.ino = st.ino;
		const tail = ctx.tailJsonl(path, { backlog: 'separate' });
		bound.closes.set('tail', () => tail.close());
		let records: unknown[] = [];
		try {
			records = await tail.backlog;
		} catch (error) {
			if (!bound.released) ctx?.reportError(error);
		}
		if (!ctx || bound.released || bound.path !== path) return;
		if (mode === 'live') {
			for (const rec of records) {
				try {
					handleRecord(bound, rec);
				} catch (error) {
					ctx.reportError(error);
				}
			}
		} else {
			const replay = replaySeed(records, bound.processStart);
			bound.events = replay.state;
			for (const rec of records) {
				reportTitles(bound, rec);
				noteAsyncAgents(bound, rec);
				noteReported(bound, rec, false);
			}
			reportModel(bound, replay.state.model);
			ctx.emit('activity:replay', { id: bound.id, facts: replay.facts });
			applyStatus(bound);
		}
		consume(bound, tail, (rec) => handleRecord(bound, rec));
	};

	/** The transcript's directory told us something about this session's file. */
	const onTranscript = async (bound: Bound): Promise<void> => {
		if (!ctx || bound.released) return;
		if (!bound.attached) return attach(bound, 'live');
		const st = await ctx.fs.stat(bound.path).catch(() => null);
		if (!st?.isFile || st.ino == null || bound.ino == null || st.ino === bound.ino) return;
		// omp replaced the file by renaming a rewrite over it: our tail is on the old one.
		await attach(bound, 'seed');
	};

	const watchSessionDir = (bound: Bound): void => {
		if (!ctx) return;
		const name = basename(bound.path);
		const handle = ctx.watchDir(dirname(bound.path), (event) => {
			if (closed || bound.released || event.name !== name || event.type === 'delete') return;
			void inOrder(() => onTranscript(bound));
		});
		bound.closes.set('dir', () => handle.close());
		const artifacts = artifactDir(bound.path);
		if (artifacts) watchArtifacts(bound, artifacts);
	};

	const teardown = (bound: Bound): void => {
		bound.released = true;
		for (const close of bound.closes.values()) close();
		bound.closes.clear();
		for (const agent of bound.agents.values()) {
			for (const close of agent.closes.splice(0)) close();
		}
		if (bounds.get(bound.id) === bound) bounds.delete(bound.id);
		if (!boundOf(bound.pid)) {
			pidWatches.get(bound.pid)?.stop();
			pidWatches.delete(bound.pid);
		}
	};

	const closeBound = (bound: Bound): void => {
		if (bound.released) return;
		if (bound.events.turnOpen) {
			ctx?.emit('turn', { sessionId: bound.id, type: 'turn-ended', outcome: 'interrupted' });
		}
		for (const agent of bound.agents.values()) {
			if (agent.facts.status === 'running') finishAgent(bound, agent, 'cancelled');
		}
		teardown(bound);
		ctx?.emit('session:close', { id: bound.id });
	};

	const processExited = (pid: number): void => {
		if (closed) return;
		stalePids.add(pid);
		for (const state of roots.values()) {
			for (const [path, client] of state.clients)
				if (client.pid === pid) state.clients.delete(path);
		}
		const bound = boundOf(pid);
		if (bound) closeBound(bound);
	};

	const acquireProcess = (pid: number): void => {
		if (!ctx || pidWatches.has(pid)) return;
		const watch = ctx.watchProcess(pid, () => processExited(pid));
		if (watch === 'unsupported') processWatchUnsupported = true;
		pidWatches.set(pid, watch === 'unsupported' ? undefined : watch);
	};

	/** Without process events, a death is only noticed when something else happens. */
	const revalidateBound = async (only?: number): Promise<void> => {
		if (!ctx) return;
		for (const bound of [...bounds.values()]) {
			if (only != null && bound.pid !== only) continue;
			const info = await ctx.processInfo(bound.pid);
			if (!info.alive) processExited(bound.pid);
		}
	};

	const bind = async (
		state: RootState,
		terminal: string,
		crumb: KnownBreadcrumb,
		client: Client,
	): Promise<void> => {
		if (!ctx || closed || bounds.has(crumb.sessionId)) return;
		const boundAt = Date.now();
		const st = await ctx.fs.stat(crumb.sessionPath).catch(() => null);
		let cwd = crumb.cwd;
		let startedAt = crumb.startedAt;
		if (st?.isFile) {
			const head = await readHead(ctx.fs, crumb.sessionPath, { requireNameMatch: true });
			if (head?.id !== crumb.sessionId) return;
			cwd = head.cwd;
			startedAt = head.startedAt ?? startedAt;
		}
		if (!ctx || closed || bounds.has(crumb.sessionId)) return;
		const bound: Bound = {
			id: crumb.sessionId,
			pid: client.pid,
			root: state.root,
			terminal,
			cwd,
			path: crumb.sessionPath,
			attached: false,
			events: initialEventsState(),
			processStart: client.startTime,
			promptTitled: false,
			seeding: true,
			boundAt,
			asyncAgents: new Set(),
			reported: new Map(),
			pending: new Set(),
			agents: new Map(),
			closes: new Map(),
			released: false,
		};
		bounds.set(bound.id, bound);
		ctx.emit(st?.isFile && !crumb.fresh ? 'session:open' : 'session:create', {
			id: bound.id,
			harness: HARNESS,
			provider: PROVIDER,
			pid: bound.pid,
			cwd,
			kind: 'interactive',
			...(startedAt != null ? { startedAt } : {}),
		});
		acquireProcess(bound.pid);
		if (st?.isFile) await attach(bound, 'seed');
		else applyStatus(bound);
		if (bound.released) return;
		watchSessionDir(bound);
		await settle(bound);
		bound.seeding = false;
		seedAgents(bound);
	};

	/** Same session, new file: `/move`, or omp re-rooting the transcript under another cwd. */
	const relocate = async (bound: Bound, crumb: KnownBreadcrumb): Promise<void> => {
		if (!ctx || bound.released) return;
		for (const [key, close] of [...bound.closes]) {
			close();
			bound.closes.delete(key);
		}
		bound.path = crumb.sessionPath;
		bound.attached = false;
		const head = await readHead(ctx.fs, bound.path, { requireNameMatch: true });
		if (!ctx || bound.released) return;
		reportCwd(bound, head?.cwd ?? crumb.cwd);
		bound.seeding = true;
		bound.boundAt = Date.now();
		await attach(bound, 'seed');
		if (bound.released) return;
		watchSessionDir(bound);
		await settle(bound);
		bound.seeding = false;
		seedAgents(bound);
	};

	/**
	 * Reconcile one terminal: the breadcrumb says which session it is on, a live presence pid
	 * with that controlling terminal says who is running it. Both must agree before anything
	 * is bound, and either may be the one that just changed.
	 */
	const syncTerminal = async (state: RootState, terminal: string): Promise<void> => {
		if (!ctx || closed || !isTerminalName(terminal)) return;
		if (processWatchUnsupported) await revalidateBound();
		const crumb = await readBreadcrumb(ctx.fs, join(state.root.terminalSessions, terminal));
		if (!ctx || closed || !crumb) return;
		let owner: Client | undefined;
		for (const client of state.clients.values()) {
			if (client.terminal !== terminal || stalePids.has(client.pid)) continue;
			// omp rewrites the breadcrumb at every launch. One older than the process was
			// left by an earlier run on this terminal and is not this process's.
			if (client.startTime != null && crumb.mtimeMs < client.startTime - BREADCRUMB_SLACK_MS) {
				continue;
			}
			if (!owner || (client.startTime ?? 0) > (owner.startTime ?? 0)) owner = client;
		}
		if (!owner) return;
		const current = boundOn(state, terminal);
		if (current && current.pid === owner.pid && current.id === crumb.sessionId) {
			if (current.path !== crumb.sessionPath) await relocate(current, crumb);
			return;
		}
		if (current) closeBound(current);
		const held = boundOf(owner.pid);
		if (held) closeBound(held);
		await bind(state, terminal, crumb, owner);
	};

	const onPresence = async (state: RootState, path: string): Promise<void> => {
		if (!ctx || closed) return;
		const presence = await readPresence(ctx.fs, path);
		if (!ctx || closed || !presence || stalePids.has(presence.pid)) return;
		const info = await ctx.processInfo(presence.pid);
		if (!ctx || closed || !info.alive) return;
		const tty = await ctx.processes.tty?.(presence.pid).catch(() => undefined);
		if (!ctx || closed) return;
		const client: Client = { pid: presence.pid, startTime: info.startTime };
		if (tty) client.terminal = breadcrumbNameOf(tty);
		state.clients.set(path, client);
		if (client.terminal) await syncTerminal(state, client.terminal);
	};

	const onPresenceGone = async (state: RootState, path: string): Promise<void> => {
		const client = state.clients.get(path);
		state.clients.delete(path);
		if (!client) return;
		const bound = boundOf(client.pid);
		if (bound) closeBound(bound);
		if (processWatchUnsupported) await revalidateBound();
	};

	// ---- prompt history ------------------------------------------------------------------

	const historyFailed = (state: RootState, error: unknown): void => {
		if (state.historyFailed) return;
		state.historyFailed = true;
		state.watches.get('history')?.close();
		state.watches.delete('history');
		ctx?.reportError(error);
	};

	const maxHistoryId = async (state: RootState): Promise<number> => {
		if (!ctx?.sqlite || !(await ctx.fs.stat(state.root.historyDb).catch(() => null))) return 0;
		const rows = await ctx.sqlite.query(state.root.historyDb, MAX_ID);
		return Number(rows[0]?.id ?? 0) || 0;
	};

	const seedHistory = async (state: RootState): Promise<void> => {
		const max = await maxHistoryId(state);
		const newest =
			max && ctx?.sqlite ? await ctx.sqlite.query(state.root.historyDb, NEWEST_ROWS) : [];
		state.history = seedCursor(max, newest);
	};

	const onHistoryRow = (row: SqliteRow): void => {
		const bound = typeof row.session_id === 'string' ? bounds.get(row.session_id) : undefined;
		// Once a transcript exists the prompt is appended to it on submit, and that is the record.
		if (!ctx || !bound || bound.released || bound.attached) return;
		const at = typeof row.created_at === 'number' ? row.created_at * 1000 : undefined;
		if (typeof row.prompt === 'string') reportPrompt(bound, row.prompt.trim());
		for (const fact of promptSubmitted(bound.events, at)) {
			ctx.emit('turn', { sessionId: bound.id, ...fact });
		}
		applyStatus(bound);
	};

	const onHistory = async (state: RootState): Promise<void> => {
		if (!ctx?.sqlite || closed || state.historyFailed || !state.history) return;
		try {
			if (!(await ctx.fs.stat(state.root.historyDb).catch(() => null))) return;
			const cursor = state.history;
			const rows = await ctx.sqlite.query(state.root.historyDb, HISTORY_ROWS, [
				cursor.id,
				cursor.at,
			]);
			if (!ctx || closed) return;
			const fresh = takeFresh(cursor, rows);
			for (const row of fresh) {
				try {
					onHistoryRow(row);
				} catch (error) {
					ctx.reportError(error);
				}
			}
			if (fresh.length === 0) {
				// omp's history GC rebuilds the table; ids may restart below where we were.
				const max = await maxHistoryId(state);
				if (max < cursor.id) cursor.id = max;
			}
		} catch (error) {
			historyFailed(state, error);
		}
	};

	/** omp writes no transcript until the first reply ends, but records the prompt at once. */
	const watchHistory = async (state: RootState): Promise<void> => {
		if (!ctx?.sqlite) return;
		try {
			await seedHistory(state);
		} catch (error) {
			historyFailed(state, error);
			return;
		}
		if (!ctx || closed) return;
		const handle = ctx.watchFile(
			historyWalPath(state.root),
			() => void inOrder(() => onHistory(state)),
			{
				heldOpen: true,
			},
		);
		state.watches.set('history', handle);
	};

	// ---- roots ---------------------------------------------------------------------------

	const watchClients = (state: RootState, dir: string): void => {
		if (!ctx || state.watches.has(dir)) return;
		const handle = ctx.watchDir(dir, (event) => {
			if (closed || !event.name.endsWith('.json')) return;
			if (event.type === 'delete') void inOrder(() => onPresenceGone(state, event.path));
			else void inOrder(() => onPresence(state, event.path));
		});
		state.watches.set(dir, handle);
	};

	const startRoot = async (root: Root, profile?: string): Promise<void> => {
		if (!ctx || closed || roots.has(root.daemons)) return;
		const state: RootState = {
			root,
			...(profile ? { profile } : {}),
			clients: new Map(),
			watches: new Map(),
			historyFailed: false,
		};
		roots.set(root.daemons, state);
		const daemons = ctx.watchDir(root.daemons, (event) => {
			if (closed) return;
			const clients = join(event.path, 'clients');
			if (event.type !== 'delete') return watchClients(state, clients);
			state.watches.get(clients)?.close();
			state.watches.delete(clients);
		});
		state.watches.set(root.daemons, daemons);
		const crumbs = ctx.watchDir(root.terminalSessions, (event) => {
			if (closed || event.type === 'delete') return;
			void inOrder(() => syncTerminal(state, event.name));
		});
		state.watches.set(root.terminalSessions, crumbs);
		await watchHistory(state);
	};

	/** A deleted profile: its sessions close, and nothing of it is watched any more. */
	const stopProfile = (profile: string): void => {
		for (const [key, state] of [...roots]) {
			if (state.profile !== profile) continue;
			for (const handle of state.watches.values()) handle.close();
			roots.delete(key);
			for (const bound of [...bounds.values()]) if (bound.root === state.root) closeBound(bound);
		}
	};

	const onProfile = async (fs: ListContext['fs'], name: string): Promise<void> => {
		if (!ctx || closed) return;
		if ((await profileNames(fs, options)).includes(name)) {
			await startRoot(await resolveRoot(fs, options, name), name);
		} else {
			stopProfile(name);
		}
	};

	const track = (work: Promise<void>): void => {
		const tracked = work
			.catch((error: unknown) => {
				if (!closed) ctx?.reportError(error);
			})
			.finally(() => starting.delete(tracked));
		starting.add(tracked);
	};

	/** Initial scans open further watches (a project's `clients`, a profile's root). */
	const settled = async (): Promise<void> => {
		for (;;) {
			const before = [...roots.values()].reduce((n, state) => n + state.watches.size, roots.size);
			await Promise.all([...starting]);
			const readies = [...roots.values()].flatMap((state) => [...state.watches.values()]);
			await Promise.all([...profileWatches, ...readies].map((handle) => handle.ready));
			const after = [...roots.values()].reduce((n, state) => n + state.watches.size, roots.size);
			if (after === before && starting.size === 0) return;
		}
	};

	const rootsFor = (fs: ListContext['fs']): Promise<Root[]> => resolveRoots(fs, options);

	const sessionPathOf = async (fs: ListContext['fs'], id: string): Promise<string | undefined> =>
		bounds.get(id)?.path ?? findSessionFile(fs, await rootsFor(fs), id);

	return {
		id: PROVIDER,
		harness: HARNESS,
		async watch(watchCtx) {
			ctx = watchCtx;
			closed = false;
			track(
				(async () => {
					await startRoot(await resolveRoot(watchCtx.fs, options));
				})(),
			);
			for (const dir of profileDirs(options)) {
				const handle = watchCtx.watchDir(dir, (event) => {
					if (closed || !isProfileName(event.name)) return;
					track(inOrder(() => onProfile(watchCtx.fs, event.name)));
				});
				profileWatches.push(handle);
			}
			await settled();
			await drain();
			return () => {
				closed = true;
				for (const handle of profileWatches.splice(0)) handle.close();
				for (const state of roots.values()) {
					for (const handle of state.watches.values()) handle.close();
				}
				roots.clear();
				for (const bound of [...bounds.values()]) teardown(bound);
				for (const handle of pidWatches.values()) handle?.stop();
				pidWatches.clear();
				stalePids.clear();
				ctx = undefined;
			};
		},
		async revalidate(watchCtx, pid) {
			ctx ??= watchCtx;
			await revalidateBound(pid);
		},
		async *list(listCtx: ListContext) {
			yield* await listSessions(listCtx.fs, await rootsFor(listCtx.fs), {
				since: listCtx.since,
				id: listCtx.id,
			});
		},
		async *inspect(inspectCtx: InspectContext, id: string): AsyncIterable<SessionEvent> {
			const sessionPath = await sessionPathOf(inspectCtx.fs, id);
			if (!sessionPath) return;
			const artifacts = artifactDir(sessionPath);
			const path = !inspectCtx.subagentId
				? sessionPath
				: artifacts
					? (await childFiles(inspectCtx.fs, artifacts)).find(
							(file) => agentIdOf(file) === inspectCtx.subagentId,
						)
					: undefined;
			if (!path) return;
			const state: ChatMapState = {};
			if (!inspectCtx.follow) {
				for (const rec of await readRecords(inspectCtx.fs, path)) yield* mapRecord(rec, state);
				return;
			}
			for await (const rec of followRecords(inspectCtx.fs, path, inspectCtx.signal)) {
				const mapped = mapRecord(rec, state);
				if (mapped.length) yield* mapped;
				else yield { kind: 'other', raw: rec };
			}
		},
		async subagents(inspectCtx, sessionId) {
			const sessionPath = await sessionPathOf(inspectCtx.fs, sessionId);
			return sessionPath ? subagentsOnDisk(inspectCtx.fs, sessionPath, sessionId) : [];
		},
	};
}
