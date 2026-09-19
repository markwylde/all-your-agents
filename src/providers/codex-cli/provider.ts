import { basename } from 'node:path';
import { decodeUtf8 } from '../../helpers/bytes.ts';
import { tailJsonl } from '../../helpers/tail-jsonl.ts';
import type { ProcessWatchHandle } from '../../helpers/types.ts';
import type { InspectContext, ListContext, Provider, WatchContext } from '../../provider.ts';
import type { SessionEvent, SubagentFacts, SubagentStatus } from '../../types.ts';
import { replayRecords } from './activity.ts';
import {
	deriveStatus,
	type EventsState,
	endStaleTurn,
	envelope,
	initialEventsState,
	reduceRecord,
} from './events.ts';
import {
	childHistoryStatus,
	listRolloutFiles,
	mapRecord,
	readMetaAt,
	realUserText,
	resolveRollout,
} from './journal.ts';
import { listSessions } from './list.ts';
import {
	codexHome,
	isRolloutName,
	type PathOptions,
	parseLockName,
	parseRolloutName,
	sessionIndexPath,
	sessionsDir,
	threadLockPath,
	threadLocksDir,
} from './paths.ts';
import { acceptMeta, type SessionMeta } from './session-meta.ts';
import { completionOf, spawnIds } from './subagents.ts';

type Tail = AsyncIterable<unknown> & { close(): void; backlog: Promise<unknown[]> };

type Agent = {
	facts: SubagentFacts;
	reported: boolean;
	path?: string;
	closes: (() => void)[];
};

type Bound = {
	id: string;
	pid: number;
	cwd: string;
	path: string;
	events: EventsState;
	/** Start time of the holding process, when the platform reports it. */
	processStart?: number;
	status?: 'running' | 'idle';
	model?: string;
	promptTitled: boolean;
	agents: Map<string, Agent>;
	closes: Map<string, () => void>;
	released: boolean;
};

const HARNESS = 'Codex';
const PROVIDER = 'codex-cli';

function isDatePart(name: string, depth: number): boolean {
	return depth === 0 ? /^\d{4}$/.test(name) : /^\d{2}$/.test(name);
}

export function codexCli(options: PathOptions = {}): Provider {
	let ctx: WatchContext | undefined;
	let closed = false;
	let primed = false;
	let processWatchUnsupported = false;
	const bounds = new Map<string, Bound>();
	const pidWatches = new Map<number, { handle?: ProcessWatchHandle; ids: Set<string> }>();
	const stale = new Set<string>();
	const notRoots = new Set<string>();
	const knownThreads = new Set<string>();
	const dirWatches = new Map<string, { close(): void; ready?: Promise<void> }>();
	/** Newest plain rollout per thread id, so a thread lock can be resolved without a scan. */
	const rolloutPaths = new Map<string, string>();
	const knownPaths = new Map<string, string>();
	let catchUp = false;

	const homeOf = (): string => codexHome(options);

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

	const acquireProcess = (bound: Bound): void => {
		if (!ctx) return;
		const existing = pidWatches.get(bound.pid);
		if (existing) {
			existing.ids.add(bound.id);
			return;
		}
		const pid = bound.pid;
		const watch = ctx.watchProcess(pid, () => {
			if (closed) return;
			for (const b of [...bounds.values()]) {
				if (b.pid !== pid) continue;
				stale.add(`${pid}:${b.id}`);
				closeBound(b);
			}
		});
		if (watch === 'unsupported') processWatchUnsupported = true;
		pidWatches.set(pid, {
			handle: watch === 'unsupported' ? undefined : watch,
			ids: new Set([bound.id]),
		});
	};

	const releaseProcess = (bound: Bound): void => {
		const entry = pidWatches.get(bound.pid);
		if (!entry) return;
		entry.ids.delete(bound.id);
		if (entry.ids.size > 0) return;
		entry.handle?.stop();
		pidWatches.delete(bound.pid);
	};

	const teardown = (bound: Bound): void => {
		bound.released = true;
		for (const close of bound.closes.values()) close();
		bound.closes.clear();
		for (const agent of bound.agents.values()) {
			for (const close of agent.closes.splice(0)) close();
		}
		releaseProcess(bound);
		if (bounds.get(bound.id) === bound) bounds.delete(bound.id);
		if (knownPaths.get(bound.id) === bound.path) knownPaths.delete(bound.id);
	};

	const closeBound = (bound: Bound): void => {
		if (bound.released) return;
		if (bound.events.turnOpen) {
			ctx?.emit('turn', {
				sessionId: bound.id,
				type: 'turn-ended',
				outcome: 'interrupted',
			});
		}
		for (const agent of bound.agents.values()) {
			if (agent.facts.status === 'running' || agent.facts.status == null) {
				finishAgent(bound, agent, 'cancelled');
			}
		}
		teardown(bound);
		ctx?.emit('session:close', { id: bound.id });
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

	const applyStatus = (bound: Bound): void => {
		const { status } = deriveStatus(bound.events);
		if (status === bound.status) return;
		if (status === 'waiting') return;
		bound.status = status;
		ctx?.emit('session:status', { id: bound.id, status });
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

	const reportPrompt = (bound: Bound, text: string): void => {
		if (bound.promptTitled || !text) return;
		bound.promptTitled = true;
		ctx?.emit('title', { id: bound.id, title: text.slice(0, 200), source: 'prompt' });
	};

	const seedAgents = (bound: Bound): void => {
		if (!ctx || bound.released) return;
		for (const agent of bound.agents.values()) {
			if (agent.reported) continue;
			agent.reported = true;
			ctx.emit('subagent:seed', agent.facts);
		}
	};

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
		ctx?.emit('subagent:start', agent.facts);
		if (agent.facts.status && agent.facts.status !== 'running') {
			ctx?.emit('subagent:end', {
				sessionId: bound.id,
				id: agent.facts.id,
				status: agent.facts.status,
				endedAt: agent.facts.endedAt,
			});
		}
	};

	const ownerBound = (parentId: string | undefined): Bound | undefined => {
		if (!parentId) return undefined;
		if (bounds.has(parentId)) return bounds.get(parentId);
		for (const bound of bounds.values()) {
			if (bound.agents.has(parentId)) return bound;
		}
		return undefined;
	};

	const ensureAgent = (
		bound: Bound,
		id: string,
		patch: Partial<SubagentFacts>,
		seeding: boolean,
	): Agent => {
		let agent = bound.agents.get(id);
		if (!agent) {
			agent = {
				facts: {
					id,
					sessionId: bound.id,
					harness: HARNESS,
					type: patch.type ?? 'subagent',
					background: patch.background === true,
					status: patch.status ?? 'running',
				},
				reported: false,
				closes: [],
			};
			if (patch.title) agent.facts.title = patch.title;
			if (patch.parentId) agent.facts.parentId = patch.parentId;
			if (patch.startedAt != null) agent.facts.startedAt = patch.startedAt;
			if (patch.endedAt != null) agent.facts.endedAt = patch.endedAt;
			bound.agents.set(id, agent);
		} else {
			if (!agent.facts.title && patch.title) agent.facts.title = patch.title;
			if (!agent.facts.type || agent.facts.type === 'subagent') {
				if (patch.type) agent.facts.type = patch.type;
			}
			if (patch.background) agent.facts.background = true;
			if (patch.parentId && !agent.facts.parentId) agent.facts.parentId = patch.parentId;
		}
		if (!seeding && !agent.reported) reportLive(bound, agent);
		return agent;
	};

	const followChild = (bound: Bound, agent: Agent, path: string, seed: boolean): Promise<void> => {
		if (!ctx || bound.released || agent.path === path) return Promise.resolve();
		for (const close of agent.closes.splice(0)) close();
		agent.path = path;
		const opts = seed ? { backlog: 'separate' as const } : undefined;
		const tail = ctx.tailJsonl(path, opts);
		agent.closes.push(() => tail.close());
		const handleChild = (rec: unknown, seeding: boolean): void => {
			const facts = reduceRecord(initialEventsState(), rec);
			for (const fact of facts) {
				if (fact.type !== 'turn-ended') continue;
				const status: Exclude<SubagentStatus, 'running'> =
					fact.outcome === 'failed'
						? 'failed'
						: fact.outcome === 'interrupted'
							? 'cancelled'
							: 'completed';
				if (seeding) {
					agent.facts.status = status;
					agent.facts.endedAt = fact.endedAt;
				} else {
					finishAgent(bound, agent, status, fact.endedAt);
				}
			}
		};
		const seeded = seed
			? tail.backlog.then(
					(records) => {
						if (bound.released) return;
						for (const rec of records) handleChild(rec, true);
					},
					(error) => {
						if (!bound.released) ctx?.reportError(error);
					},
				)
			: Promise.resolve();
		consume(bound, tail, (rec) => handleChild(rec, false));
		return seeded;
	};

	const onChildMeta = (meta: SessionMeta, path: string, seeding: boolean): Promise<void> => {
		const parentId = meta.parentThreadId;
		if (!parentId) return Promise.resolve();
		const bound = ownerBound(parentId);
		if (!bound) return Promise.resolve();
		notRoots.add(meta.id);
		const parentIdForFacts = parentId === bound.id ? undefined : parentId;
		const agent = ensureAgent(
			bound,
			meta.id,
			{
				type: meta.agentRole ?? 'subagent',
				title: meta.agentNickname,
				parentId: parentIdForFacts,
				status: 'running',
			},
			seeding,
		);
		return followChild(bound, agent, path, seeding);
	};

	const handleRecord = (bound: Bound, rec: unknown, seeding: boolean): void => {
		if (!ctx) return;
		const env = envelope(rec);
		if (
			env?.type === 'response_item' &&
			env.payload.type === 'message' &&
			env.payload.role === 'user'
		) {
			const text = realUserText(env.payload.content);
			if (text) reportPrompt(bound, text);
		}
		const facts = seeding ? [] : reduceRecord(bound.events, rec);
		if (seeding) {
			const scratch = initialEventsState();
			reduceRecord(scratch, rec);
			bound.events.collab.push(...scratch.collab);
		}
		if (bound.events.model) reportModel(bound, bound.events.model);
		if (bound.events.cwd) reportCwd(bound, bound.events.cwd);
		if (!seeding) {
			for (const fact of facts) ctx.emit('turn', { sessionId: bound.id, ...fact });
			applyStatus(bound);
		}
		for (const hint of bound.events.collab.splice(0)) {
			for (const id of spawnIds(hint)) {
				ensureAgent(
					bound,
					id,
					{ title: hint.nicknames.get(id), type: 'subagent', status: 'running' },
					seeding,
				);
			}
			for (const [id, status] of hint.states) {
				if (status === 'open' || status === 'running') continue;
				if (!completionOf(hint, id)) continue;
				const agent = bound.agents.get(id);
				if (!agent) continue;
				if (seeding) {
					agent.facts.status = status;
				} else {
					finishAgent(bound, agent, status);
				}
			}
		}
		if (!seeding && !bound.events.turnOpen) {
			for (const agent of bound.agents.values()) {
				if (agent.facts.status === 'running' || agent.facts.status == null) {
					agent.facts.background = true;
				}
			}
		}
	};

	const attach = async (bound: Bound, path: string, seed: boolean): Promise<void> => {
		if (!ctx || bound.released) return;
		for (const close of bound.closes.values()) close();
		bound.closes.clear();
		bound.path = path;
		knownPaths.set(bound.id, path);
		const opts = seed ? { backlog: 'separate' as const } : undefined;
		const tail = ctx.tailJsonl(path, opts);
		bound.closes.set('tail', () => tail.close());
		if (seed) {
			let records: unknown[] = [];
			try {
				records = await tail.backlog;
			} catch (error) {
				if (!bound.released) ctx?.reportError(error);
			}
			if (!ctx || bound.released || bound.path !== path) return;
			const replay = replayRecords(records);
			replay.facts.push(...endStaleTurn(replay.state, bound.processStart));
			bound.events = replay.state;
			reportModel(bound, replay.state.model);
			if (replay.state.cwd) reportCwd(bound, replay.state.cwd);
			for (const rec of records) {
				try {
					handleRecord(bound, rec, true);
				} catch (error) {
					ctx.reportError(error);
				}
			}
			ctx.emit('activity:replay', { id: bound.id, facts: replay.facts });
			applyStatus(bound);
		}
		consume(bound, tail, (rec) => handleRecord(bound, rec, false));
	};

	const holdersOf = async (path: string): Promise<number[]> => {
		if (!ctx?.processes.holders) return [];
		try {
			return await ctx.processes.holders(path);
		} catch {
			return [];
		}
	};

	const reprobePid = async (pid: number, except?: string): Promise<void> => {
		if (!ctx) return;
		for (const bound of [...bounds.values()]) {
			if (bound.pid !== pid || bound.id === except || bound.released) continue;
			const pids = await holdersOf(bound.path);
			if (!ctx || closed) return;
			if (!pids.includes(pid)) closeBound(bound);
		}
	};

	const bind = async (
		path: string,
		pid: number,
		meta: SessionMeta,
		mode: 'create' | 'open',
	): Promise<void> => {
		if (!ctx || closed || bounds.has(meta.id)) return;
		const key = `${pid}:${meta.id}`;
		if (stale.has(key)) return;
		const info = await ctx.processInfo(pid);
		if (!ctx || closed) return;
		if (!acceptMeta(meta, info)) return;
		await reprobePid(pid);
		if (!ctx || closed || bounds.has(meta.id)) return;
		const existed = knownThreads.has(meta.id);
		knownThreads.add(meta.id);
		const bound: Bound = {
			id: meta.id,
			pid,
			cwd: meta.cwd,
			path,
			events: initialEventsState(),
			processStart: info.startTime,
			promptTitled: false,
			agents: new Map(),
			closes: new Map(),
			released: false,
		};
		bounds.set(meta.id, bound);
		knownPaths.set(meta.id, path);
		ctx.emit(existed || mode === 'open' ? 'session:open' : 'session:create', {
			id: bound.id,
			harness: HARNESS,
			provider: PROVIDER,
			pid,
			cwd: bound.cwd,
			kind: meta.kind,
			startedAt: meta.timestamp,
		});
		acquireProcess(bound);
		await attach(bound, path, true);
		if (!catchUp) {
			await linkHeldChildren(true);
			seedAgents(bound);
		}
	};

	const linkHeldChildren = async (seeding: boolean): Promise<void> => {
		if (!ctx?.processes.heldUnder) return;
		let held: { path: string; pid: number }[] = [];
		try {
			held = await ctx.processes.heldUnder(sessionsDir(homeOf()));
		} catch {
			return;
		}
		for (const { path } of held) {
			const parsed = parseRolloutName(basename(path));
			if (!parsed || parsed.compressed || notRoots.has(parsed.threadId)) continue;
			if (bounds.has(parsed.threadId)) continue;
			const meta = await readMetaAt(ctx.fs, path);
			if (!meta || meta.root) continue;
			await onChildMeta(meta, path, seeding);
		}
	};

	const onRollout = async (path: string): Promise<void> => {
		if (!ctx || closed) return;
		const parsed = parseRolloutName(basename(path));
		if (!parsed || parsed.compressed) return;
		if (notRoots.has(parsed.threadId)) return;
		const existing = bounds.get(parsed.threadId);
		if (existing && !existing.released) {
			if (existing.path !== path) {
				await attach(existing, path, true);
			}
			await reprobePid(existing.pid);
			if (processWatchUnsupported) {
				const info = await ctx.processInfo(existing.pid);
				if (!info.alive) closeBound(existing);
			}
			return;
		}
		const meta = await readMetaAt(ctx.fs, path);
		if (!meta) return;
		if (!meta.root) {
			await onChildMeta(meta, path, false);
			return;
		}
		const pids = await holdersOf(path);
		if (!ctx || closed || !pids.length) return;
		const pid = pids.find((p) => !stale.has(`${p}:${meta.id}`));
		if (pid == null) return;
		await bind(path, pid, meta, knownThreads.has(meta.id) ? 'open' : 'create');
	};

	const onDelete = async (path: string): Promise<void> => {
		for (const bound of [...bounds.values()]) {
			if (bound.path !== path || bound.released) continue;
			if (ctx?.processes.heldUnder) {
				try {
					const held = await ctx.processes.heldUnder(sessionsDir(homeOf()));
					const other = held.find((row) => {
						const name = parseRolloutName(basename(row.path));
						return name?.threadId === bound.id && row.path !== path && row.pid === bound.pid;
					});
					if (other) {
						await attach(bound, other.path, true);
						continue;
					}
				} catch {
					// close below
				}
			}
			closeBound(bound);
		}
	};

	const watchLevel = (path: string, depth: number): void => {
		if (!ctx || dirWatches.has(path)) return;
		const handle = ctx.watchDir(path, (event) => {
			if (closed) return;
			if (depth < 3) {
				if (event.type === 'delete') {
					const prefix = `${event.path}/`;
					for (const [p, h] of [...dirWatches]) {
						if (p === event.path || p.startsWith(prefix)) {
							h.close();
							dirWatches.delete(p);
						}
					}
					return;
				}
				if (isDatePart(event.name, depth)) watchLevel(event.path, depth + 1);
				return;
			}
			if (!isRolloutName(event.name)) return;
			const parsed = parseRolloutName(event.name);
			if (event.type === 'delete') {
				if (parsed && rolloutPaths.get(parsed.threadId) === event.path) {
					rolloutPaths.delete(parsed.threadId);
				}
				void inOrder(() => onDelete(event.path));
				return;
			}
			if (parsed && !parsed.compressed) rolloutPaths.set(parsed.threadId, event.path);
			if (!primed) return;
			void inOrder(() => onRollout(event.path));
		});
		dirWatches.set(path, handle);
	};

	/**
	 * Codex creates `thread-writer-locks/<thread-id>.lock` when a process opens a thread for
	 * writing (a new thread, `codex resume`, `codex exec resume`) and holds it open while the
	 * thread is live (ADR 0002). Its creation says which thread; its holder is the pid. A new
	 * thread has no rollout until its first prompt, and the day directory reports that one.
	 */
	const onLock = async (threadId: string): Promise<void> => {
		if (!ctx || closed || bounds.has(threadId) || notRoots.has(threadId)) return;
		const path = rolloutPaths.get(threadId);
		if (!path) return;
		const pids = await holdersOf(threadLockPath(homeOf(), threadId));
		if (!ctx || closed || bounds.has(threadId)) return;
		const pid = pids.find((p) => !stale.has(`${p}:${threadId}`));
		if (pid == null) return;
		const meta = await readMetaAt(ctx.fs, path);
		if (!meta?.root) return;
		await bind(path, pid, meta, 'open');
	};

	const watchLocks = (): void => {
		if (!ctx) return;
		const dir = threadLocksDir(homeOf());
		const handle = ctx.watchDir(dir, (event) => {
			if (closed || !primed || event.type === 'delete') return;
			const threadId = parseLockName(event.name);
			if (threadId) void inOrder(() => onLock(threadId));
		});
		dirWatches.set(dir, handle);
	};

	const bindHeld = async (): Promise<void> => {
		if (!ctx?.processes.heldUnder) return;
		let held: { path: string; pid: number }[] = [];
		try {
			held = await ctx.processes.heldUnder(sessionsDir(homeOf()));
		} catch {
			return;
		}
		if (!ctx || closed) return;
		const children: { meta: SessionMeta; path: string }[] = [];
		catchUp = true;
		try {
			for (const { path, pid } of held) {
				const parsed = parseRolloutName(basename(path));
				if (!parsed || parsed.compressed) continue;
				if (bounds.has(parsed.threadId)) continue;
				const meta = await readMetaAt(ctx.fs, path);
				if (!meta) continue;
				if (!meta.root) {
					children.push({ meta, path });
					continue;
				}
				if (stale.has(`${pid}:${meta.id}`)) continue;
				await bind(path, pid, meta, 'open');
			}
			let leftover = children;
			while (leftover.length) {
				const next: typeof leftover = [];
				const linked: Promise<void>[] = [];
				for (const child of leftover) {
					if (ownerBound(child.meta.parentThreadId ?? '')) {
						linked.push(onChildMeta(child.meta, child.path, true));
					} else {
						next.push(child);
					}
				}
				if (!linked.length) break;
				await Promise.all(linked);
				leftover = next;
			}
			for (const bound of bounds.values()) seedAgents(bound);
		} finally {
			catchUp = false;
		}
	};

	const indexTitles = async (rec: unknown): Promise<void> => {
		if (!rec || typeof rec !== 'object') return;
		const row = rec as Record<string, unknown>;
		if (typeof row.id !== 'string' || typeof row.thread_name !== 'string') return;
		if (!bounds.has(row.id)) return;
		ctx?.emit('title', { id: row.id, title: row.thread_name.slice(0, 200), source: 'harness' });
	};

	return {
		id: PROVIDER,
		harness: HARNESS,
		async watch(watchCtx) {
			ctx = watchCtx;
			closed = false;
			primed = false;
			watchLevel(sessionsDir(homeOf()), 0);
			watchLocks();
			for (;;) {
				const n = dirWatches.size;
				await Promise.all([...dirWatches.values()].map((h) => h.ready ?? Promise.resolve()));
				if (dirWatches.size === n) break;
			}
			try {
				const files = await listRolloutFiles(watchCtx.fs, homeOf());
				files.sort((a, b) => (a.mtimeMs ?? 0) - (b.mtimeMs ?? 0));
				for (const file of files) {
					knownThreads.add(file.threadId);
					if (!file.compressed) rolloutPaths.set(file.threadId, file.path);
				}
			} catch {
				// history may be empty
			}
			await inOrder(bindHeld);
			await drain();
			primed = true;
			const index = watchCtx.tailJsonl(sessionIndexPath(homeOf()));
			void (async () => {
				try {
					for await (const rec of index) {
						if (closed) break;
						try {
							await indexTitles(rec);
						} catch (error) {
							watchCtx.reportError(error);
						}
					}
				} catch (error) {
					if (!closed) watchCtx.reportError(error);
				}
			})();
			return () => {
				closed = true;
				primed = false;
				index.close();
				for (const h of dirWatches.values()) h.close();
				dirWatches.clear();
				rolloutPaths.clear();
				for (const bound of [...bounds.values()]) teardown(bound);
				for (const entry of pidWatches.values()) entry.handle?.stop();
				pidWatches.clear();
				notRoots.clear();
				knownThreads.clear();
				stale.clear();
				ctx = undefined;
			};
		},
		async revalidate(watchCtx, pid) {
			ctx ??= watchCtx;
			if (pid != null) {
				await reprobePid(pid);
				for (const bound of [...bounds.values()]) {
					if (bound.pid !== pid) continue;
					const info = await watchCtx.processInfo(pid);
					if (!info.alive) closeBound(bound);
				}
				return;
			}
			for (const bound of [...bounds.values()]) {
				await reprobePid(bound.pid);
				const info = await watchCtx.processInfo(bound.pid);
				if (!info.alive) closeBound(bound);
			}
		},
		async *list(listCtx: ListContext) {
			yield* await listSessions(listCtx.fs, homeOf(), { since: listCtx.since, id: listCtx.id });
		},
		async *inspect(inspectCtx: InspectContext, id: string): AsyncIterable<SessionEvent> {
			const path = inspectCtx.subagentId
				? await resolveRollout(inspectCtx.fs, homeOf(), inspectCtx.subagentId)
				: await resolveRollout(inspectCtx.fs, homeOf(), id);
			if (!path || path.endsWith('.zst')) return;
			const state = {};
			if (inspectCtx.follow) {
				const tail = tailJsonl(inspectCtx.fs, path);
				const stop = (): void => tail.close();
				inspectCtx.signal?.addEventListener('abort', stop, { once: true });
				if (inspectCtx.signal?.aborted) stop();
				try {
					for await (const rec of tail) {
						const mapped = mapRecord(rec, state);
						if (mapped.length) yield* mapped;
						else yield { kind: 'other', raw: rec };
					}
				} finally {
					inspectCtx.signal?.removeEventListener('abort', stop);
					tail.close();
				}
				return;
			}
			const st = await inspectCtx.fs.stat(path);
			if (!st) return;
			const text = decodeUtf8(await inspectCtx.fs.readRange(path, 0, st.size));
			for (const line of text.split('\n')) {
				if (!line.trim()) continue;
				let rec: unknown;
				try {
					rec = JSON.parse(line);
				} catch {
					continue;
				}
				yield* mapRecord(rec, state);
			}
		},
		async subagents(inspectCtx, sessionId) {
			const files = await listRolloutFiles(inspectCtx.fs, homeOf());
			const metas: { meta: SessionMeta; path: string }[] = [];
			for (const file of files) {
				if (file.compressed) continue;
				const meta = await readMetaAt(inspectCtx.fs, file.path);
				if (!meta) continue;
				metas.push({ meta, path: file.path });
			}
			const children = (parent: string) =>
				metas.filter((row) => row.meta.parentThreadId === parent);
			const walk = async (parent: string, root: string): Promise<SubagentFacts[]> => {
				const out: SubagentFacts[] = [];
				for (const { meta, path } of children(parent)) {
					const facts: SubagentFacts = {
						id: meta.id,
						sessionId: root,
						harness: HARNESS,
						type: meta.agentRole ?? 'subagent',
						background: false,
						status: await childHistoryStatus(inspectCtx.fs, path),
					};
					if (meta.agentNickname) facts.title = meta.agentNickname;
					if (parent !== root) facts.parentId = parent;
					if (meta.timestamp != null) facts.startedAt = meta.timestamp;
					out.push(facts, ...(await walk(meta.id, root)));
				}
				return out;
			};
			return walk(sessionId, sessionId);
		},
	};
}
