import { join } from 'node:path';
import { decodeUtf8, TooLargeError } from '../../helpers/bytes.ts';
import { tailJsonl } from '../../helpers/tail-jsonl.ts';
import type { Fs, ProcessInfo, ProcessWatchHandle } from '../../helpers/types.ts';
import type { InspectContext, ListContext, Provider, WatchContext } from '../../provider.ts';
import type { SessionEvent, SessionStatus, SubagentFacts, SubagentStatus } from '../../types.ts';
import { replayEvents, withError } from './activity.ts';
import { deriveStatus, type EventsState, initialEventsState, reduceEvent } from './events.ts';
import { acceptEntry, INDEX_MAX_BYTES, type IndexEntry, parseIndex } from './index-file.ts';
import {
	type ChatMapState,
	mapChatRecord,
	modelOf,
	promptTitle,
	resolveSessionDir,
	textOf,
} from './journal.ts';
import { isSubagentKind, listSessions, readSummary, type Summary } from './list.ts';
import { followRewinds, type Rewind, recentRewinds } from './log.ts';
import { derivedSessionDir, grokHome, indexPath, logPath, type PathOptions } from './paths.ts';
import { META_MAX_BYTES, parseMeta, parseSpawnResult, type SubagentMeta } from './subagents.ts';

type Tail = AsyncIterable<unknown> & { close(): void };

/** A `spawn_subagent` call, linked to the subagent it launched once that is known. */
type Spawn = {
	callId: string;
	/** The subagent whose conversation made the call; absent for the session itself. */
	owner?: string;
	type: string;
	title?: string;
	background: boolean;
	subagentId?: string;
};

type Agent = {
	facts: SubagentFacts;
	/** Reported as started (or seeded); until then it is only known here. */
	reported: boolean;
	/** Its `subagents/<id>` directory, and the session directory of its own conversation. */
	metaDir?: string;
	childDir?: string;
	metaWatched?: boolean;
	childFollowed?: boolean;
	/** Watches held while it runs: its meta directory, its conversation, its subagents. */
	closes: (() => void)[];
};

type Bound = {
	id: string;
	pid: number;
	cwd: string;
	openedAt?: number;
	dir?: string;
	events: EventsState;
	chat: ChatMapState;
	/** Chat-history error text since the last prompt: the message a failed turn lacks. */
	chatError?: string;
	status?: SessionStatus;
	waitingFor?: string;
	model?: string;
	/** A `prompt` title has been reported; only the first real prompt is one. */
	promptTitled: boolean;
	agents: Map<string, Agent>;
	spawns: Map<string, Spawn>;
	/** Chat map state per subagent conversation being followed. */
	childChats: Map<string, ChatMapState>;
	/** The index moved it to a cwd whose directory has not appeared yet. */
	relocating: boolean;
	closes: Map<string, () => void>;
	statusFlush?: ReturnType<typeof setImmediate>;
	/** Torn down. Work that was awaiting when that happened must not attach anything. */
	released: boolean;
};

const HARNESS = 'Grok';
/** How far back a meta file looks for the spawn it answers. */
const RECENT_CHAT_BYTES = 64 * 1024;
const PROVIDER = 'grok-build';

export function grokBuild(options: PathOptions = {}): Provider {
	let ctx: WatchContext | undefined;
	let closed = false;
	let processWatchUnsupported = false;
	const bounds = new Map<string, Bound>();
	const pidWatches = new Map<number, { handle?: ProcessWatchHandle; ids: Set<string> }>();
	/** Entries whose process exited without removing them. Keyed by pid, id and registration. */
	const stale = new Set<string>();
	/** Entries that name a subagent's session: never roots. */
	const notRoots = new Set<string>();

	const homeOf = (): string => grokHome(options);
	const entryKey = (e: { pid: number; sessionId?: string; id?: string; openedAt?: number }) =>
		`${e.pid}:${e.sessionId ?? e.id}:${e.openedAt ?? ''}`;

	/**
	 * Index work is serviced strictly in order. Binding awaits the filesystem, and a
	 * rewrite or removal overtaking it would bind a session twice or revive a removed one.
	 */
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

	// Process watches: one per pid, shared by every session that pid holds.

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
				stale.add(entryKey(b));
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

	// The shared log, followed only while a session is bound.

	let log: { close(): void } | undefined;

	const followLog = (): void => {
		if (!ctx || log) return;
		log = followRewinds(ctx, logPath(homeOf()), (rewind) => {
			const bound = bounds.get(rewind.sessionId);
			if (!closed && bound) endRewound(bound, rewind);
		});
	};

	const unfollowLogIfIdle = (): void => {
		if (bounds.size > 0) return;
		log?.close();
		log = undefined;
	};

	// Teardown.

	const closeAgent = (agent: Agent): void => {
		for (const close of agent.closes.splice(0)) close();
	};

	const detachFiles = (bound: Bound): void => {
		for (const close of bound.closes.values()) close();
		bound.closes.clear();
	};

	const teardown = (bound: Bound): void => {
		bound.released = true;
		if (bound.statusFlush) clearImmediate(bound.statusFlush);
		detachFiles(bound);
		for (const agent of bound.agents.values()) closeAgent(agent);
		releaseProcess(bound);
		if (bounds.get(bound.id) === bound) bounds.delete(bound.id);
		unfollowLogIfIdle();
	};

	const closeBound = (bound: Bound): void => {
		if (bound.released) return;
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

	// Titles and model.

	const reportPromptTitle = (bound: Bound, text: string): void => {
		if (bound.promptTitled) return;
		bound.promptTitled = true;
		ctx?.emit('title', { id: bound.id, title: promptTitle(text), source: 'prompt' });
	};

	const reportModel = (bound: Bound, model: string | undefined): void => {
		if (!model || model === bound.model) return;
		bound.model = model;
		ctx?.emit('session:update', { id: bound.id, model });
	};

	const reportSummary = (bound: Bound, summary: Summary | undefined): void => {
		if (summary?.title) {
			ctx?.emit('title', {
				id: bound.id,
				title: summary.title.title,
				source: summary.title.source,
			});
		}
	};

	// Status.

	const endForeground = (bound: Bound): void => {
		for (const agent of bound.agents.values()) {
			if (agent.facts.status !== 'running' || agent.facts.background) continue;
			finishAgent(bound, agent, 'cancelled');
		}
	};

	/** Settle a new status and report it, unless it is what was reported already. */
	const applyStatus = (bound: Bound): void => {
		if (!ctx || bound.released) return;
		const next = deriveStatus(bound.events);
		if (next.status === bound.status && next.waitingFor === bound.waitingFor) return;
		bound.status = next.status;
		bound.waitingFor = next.waitingFor;
		ctx.emit('session:status', { id: bound.id, status: next.status, waitingFor: next.waitingFor });
		if (next.status === 'idle') endForeground(bound);
	};

	/**
	 * Phases change hundreds of times a turn, and a permission auto-allowed in the same
	 * batch is `waiting` for a millisecond. Status is reported once the records a read
	 * produced have all been handled: they are drained before any macrotask runs.
	 */
	const scheduleStatus = (bound: Bound): void => {
		if (bound.statusFlush) return;
		bound.statusFlush = setImmediate(() => {
			bound.statusFlush = undefined;
			applyStatus(bound);
		});
	};

	const handleEvent = (bound: Bound, rec: unknown): void => {
		if (!ctx) return;
		const facts = reduceEvent(bound.events, rec);
		const row = rec as Record<string, unknown>;
		if (row?.type === 'turn_started') reportModel(bound, bound.events.model);
		for (const fact of facts) {
			ctx.emit('turn', { sessionId: bound.id, ...withError(fact, bound.chatError) });
		}
		scheduleStatus(bound);
	};

	/**
	 * A cancel before any output rewinds the prompt and ends the turn without a
	 * `turn_ended`. Only one after the open turn started, from the same process, ends it.
	 */
	const endRewound = (bound: Bound, rewind: Rewind): void => {
		if (bound.released || !bound.events.turnOpen) return;
		if (rewind.pid != null && rewind.pid !== bound.pid) return;
		const started = bound.events.turnStartedAt;
		if (rewind.at != null && started != null && rewind.at < started) return;
		handleEvent(bound, {
			type: 'turn_ended',
			outcome: 'cancelled',
			ts: rewind.at != null ? new Date(rewind.at).toISOString() : undefined,
		});
	};

	// Subagents.

	const newAgent = (bound: Bound, id: string, from: Partial<SubagentFacts>): Agent => {
		const facts: SubagentFacts = {
			id,
			sessionId: bound.id,
			harness: HARNESS,
			type: from.type ?? 'general-purpose',
			background: from.background === true,
			status: from.status ?? 'running',
		};
		if (from.title) facts.title = from.title;
		if (from.parentId) facts.parentId = from.parentId;
		if (from.startedAt != null) facts.startedAt = from.startedAt;
		if (from.endedAt != null) facts.endedAt = from.endedAt;
		const agent: Agent = { facts, reported: false, closes: [] };
		bound.agents.set(id, agent);
		return agent;
	};

	/** Report a subagent seen live: started, and ended too if it already has. */
	const reportLive = (bound: Bound, agent: Agent): void => {
		if (!ctx || agent.reported) return;
		agent.reported = true;
		const final = agent.facts.status !== 'running' ? agent.facts.status : undefined;
		ctx.emit('subagent:start', { ...agent.facts, status: 'running' });
		if (final) {
			agent.facts.status = 'running';
			finishAgent(bound, agent, final as Exclude<SubagentStatus, 'running'>, agent.facts.endedAt);
		} else {
			void followAgent(bound, agent);
		}
	};

	/** Report what a bind found: running ones are caught up, finished ones seeded. */
	const reportSeeded = (bound: Bound): void => {
		if (!ctx) return;
		const idle = deriveStatus(bound.events).status === 'idle';
		for (const agent of bound.agents.values()) {
			if (agent.reported) continue;
			if (agent.facts.status === 'running' && idle && !agent.facts.background) {
				agent.facts.status = 'cancelled';
			}
			if (agent.facts.status === 'running') {
				reportLive(bound, agent);
				continue;
			}
			agent.reported = true;
			ctx.emit('subagent:seed', { ...agent.facts });
		}
	};

	const finishAgent = (
		bound: Bound,
		agent: Agent,
		status: Exclude<SubagentStatus, 'running'>,
		endedAt?: number,
	): void => {
		if (agent.facts.status !== 'running') return;
		agent.facts.status = status;
		if (endedAt != null) agent.facts.endedAt = endedAt;
		closeAgent(agent);
		if (!agent.reported) return;
		ctx?.emit('subagent:end', { sessionId: bound.id, id: agent.facts.id, status, endedAt });
	};

	/** The spawn this subagent answers, when one is known and not linked yet. */
	const pendingSpawnFor = (bound: Bound, meta: SubagentMeta, owner?: string): Spawn | undefined => {
		for (const spawn of bound.spawns.values()) {
			if (spawn.subagentId || spawn.owner !== owner) continue;
			if (spawn.type === meta.type && spawn.title === meta.title) return spawn;
		}
		return undefined;
	};

	/**
	 * A meta file seen before its conversation's tail reached the spawn. The meta does not
	 * say whether it runs in the background, and a start cannot be revised, so look once at
	 * the end of that conversation for the spawn and what its tool result says.
	 */
	const recentSpawn = async (
		bound: Bound,
		meta: SubagentMeta,
		owner?: string,
	): Promise<Spawn | undefined> => {
		if (!ctx) return undefined;
		const dir = owner ? bound.agents.get(owner)?.childDir : bound.dir;
		if (!dir) return undefined;
		const path = join(dir, 'chat_history.jsonl');
		let text: string;
		try {
			const st = await ctx.fs.stat(path);
			if (!st) return undefined;
			const from = Math.max(0, st.size - RECENT_CHAT_BYTES);
			text = decodeUtf8(await ctx.fs.readRange(path, from, st.size));
			// Starting mid-file, the first line is cut off.
			if (from > 0) text = text.slice(text.indexOf('\n') + 1);
		} catch {
			return undefined;
		}
		let found: Spawn | undefined;
		for (const line of text.split('\n')) {
			let rec: Record<string, unknown>;
			try {
				rec = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue;
			}
			for (const event of mapChatRecord(rec, {})) {
				if (event.kind !== 'subagent' || bound.spawns.get(event.id)?.subagentId) continue;
				if (event.type !== meta.type || event.title !== meta.title) continue;
				found = {
					callId: event.id,
					owner,
					type: meta.type,
					title: meta.title,
					background: event.background === true,
				};
			}
			if (found && rec.type === 'tool_result' && rec.tool_call_id === found.callId) {
				const result = parseSpawnResult(textOf(rec.content) ?? '');
				if (result.background) found.background = true;
			}
		}
		if (found && !bound.spawns.has(found.callId)) bound.spawns.set(found.callId, found);
		return found && bound.spawns.get(found.callId) === found ? found : undefined;
	};

	const readMeta = async (bound: Bound, metaDir: string, seeding: boolean): Promise<void> => {
		if (!ctx) return;
		const fs = ctx.fs;
		let bytes: Uint8Array;
		try {
			bytes = await fs.readFile(join(metaDir, 'meta.json'), { maxBytes: META_MAX_BYTES });
		} catch {
			return;
		}
		const hasOutput = Boolean(
			(await fs.stat(join(metaDir, 'output.json')).catch(() => null))?.isFile,
		);
		if (!ctx || bound.released) return;
		const meta = parseMeta(bytes, hasOutput);
		if (!meta) return;
		const owner =
			meta.parentSessionId && meta.parentSessionId !== bound.id ? meta.parentSessionId : undefined;
		let spawn = bound.agents.has(meta.subagentId) ? undefined : pendingSpawnFor(bound, meta, owner);
		if (!bound.agents.has(meta.subagentId) && !spawn && !seeding) {
			spawn = await recentSpawn(bound, meta, owner);
			if (!ctx || bound.released) return;
		}
		let agent = bound.agents.get(meta.subagentId);
		if (!agent) {
			if (spawn) spawn.subagentId = meta.subagentId;
			agent = newAgent(bound, meta.subagentId, {
				type: meta.type,
				title: meta.title,
				background: spawn?.background,
				parentId: owner,
				startedAt: meta.startedAt,
				status: meta.status,
				endedAt: meta.endedAt,
			});
		} else if (agent.facts.startedAt == null && meta.startedAt != null) {
			agent.facts.startedAt = meta.startedAt;
		}
		agent.metaDir = metaDir;
		if (meta.childCwd && meta.childSessionId) {
			agent.childDir = derivedSessionDir(homeOf(), meta.childCwd, meta.childSessionId);
		}
		if (!agent.reported) {
			agent.facts.status = meta.status;
			if (meta.endedAt != null) agent.facts.endedAt = meta.endedAt;
			if (!seeding) reportLive(bound, agent);
			return;
		}
		if (meta.status !== 'running') finishAgent(bound, agent, meta.status, meta.endedAt);
		else void followAgent(bound, agent);
	};

	/** Watch a `subagents/` directory: each entry is one subagent's meta directory. */
	const watchSubagents = (
		bound: Bound,
		dir: string,
		seeding: boolean,
	): { close(): void; seeded: Promise<void> } | undefined => {
		if (!ctx || bound.released) return undefined;
		const reads: Promise<void>[] = [];
		let initial = seeding;
		const handle = ctx.watchDir(dir, (event) => {
			if (event.type === 'delete') return;
			const known = bound.agents.get(event.name);
			// A running subagent's own watch reports its changes, once its meta is known.
			if (known?.reported && known.metaWatched) return;
			if (known?.reported && known.facts.status !== 'running') return;
			const read = readMeta(bound, event.path, initial);
			if (initial) reads.push(read);
		});
		const seeded = (async () => {
			await handle.ready;
			initial = false;
			await Promise.all(reads);
		})();
		return { close: () => handle.close(), seeded };
	};

	/**
	 * While a subagent runs: its meta directory (status, output), its own conversation
	 * (the subagents it launches), and its own `subagents/` directory. Each is followed
	 * once, as soon as where it lives is known.
	 */
	const followAgent = async (bound: Bound, agent: Agent): Promise<void> => {
		if (!ctx || bound.released || agent.facts.status !== 'running') return;
		if (agent.metaDir && !agent.metaWatched) {
			agent.metaWatched = true;
			const metaDir = agent.metaDir;
			const h = ctx.watchDir(metaDir, (event) => {
				if (event.name === 'meta.json' || event.name === 'output.json') {
					void readMeta(bound, metaDir, false);
				}
			});
			agent.closes.push(() => h.close());
		}
		if (agent.childFollowed) return;
		agent.childFollowed = true;
		const childDir = agent.childDir ?? (await resolveSessionDir(ctx.fs, homeOf(), agent.facts.id));
		if (!ctx || bound.released || agent.facts.status !== 'running') return;
		if (!childDir) {
			agent.childFollowed = false;
			return;
		}
		// The child's directory may not exist yet: tail its conversation once it does.
		let tail: Tail | undefined;
		const chat = ctx.watchDir(childDir, (event) => {
			if (event.name !== 'chat_history.jsonl' || tail || !ctx) return;
			if (bound.released || agent.facts.status !== 'running') return;
			const t = ctx.tailJsonl(event.path);
			tail = t;
			agent.closes.push(() => t.close());
			consume(bound, t, (rec) => handleChat(bound, rec, agent.facts.id, false));
		});
		agent.closes.push(() => chat.close());
		const nested = watchSubagents(bound, join(childDir, 'subagents'), false);
		if (nested) agent.closes.push(() => nested.close());
	};

	// Conversation.

	const handleChat = (
		bound: Bound,
		rec: unknown,
		owner: string | undefined,
		seeding: boolean,
	): void => {
		if (!ctx || !rec || typeof rec !== 'object') return;
		const row = rec as Record<string, unknown>;
		let state = bound.chat;
		if (owner) {
			state = bound.childChats.get(owner) ?? {};
			bound.childChats.set(owner, state);
		}
		for (const event of mapChatRecord(rec, state)) {
			if (!owner && event.kind === 'user') {
				bound.chatError = undefined;
				reportPromptTitle(bound, event.text);
			}
			if (!owner && event.kind === 'error') bound.chatError = event.message;
			if (event.kind === 'subagent' && !bound.spawns.has(event.id)) {
				const spawn: Spawn = {
					callId: event.id,
					owner,
					type: event.type ?? 'general-purpose',
					title: event.title,
					background: event.background === true,
				};
				bound.spawns.set(event.id, spawn);
				// The meta file may have been read first.
				for (const agent of bound.agents.values()) {
					const linked = [...bound.spawns.values()].some((s) => s.subagentId === agent.facts.id);
					if (linked || agent.facts.parentId !== owner) continue;
					if (agent.facts.type !== spawn.type || agent.facts.title !== spawn.title) continue;
					spawn.subagentId = agent.facts.id;
					if (spawn.background) agent.facts.background = true;
					break;
				}
			}
		}
		if (!owner && !bound.model) reportModel(bound, modelOf(rec));
		if (row.type !== 'tool_result' || typeof row.tool_call_id !== 'string') return;
		const spawn = bound.spawns.get(row.tool_call_id);
		const text = textOf(row.content);
		if (!spawn || !text) return;
		const result = parseSpawnResult(text);
		if (result.subagentId && !spawn.subagentId) spawn.subagentId = result.subagentId;
		if (!spawn.subagentId) return;
		let agent = bound.agents.get(spawn.subagentId);
		if (!agent) {
			agent = newAgent(bound, spawn.subagentId, {
				type: spawn.type,
				title: spawn.title,
				background: spawn.background || result.background,
				parentId: spawn.owner,
			});
		}
		if (result.background) agent.facts.background = true;
		if (!agent.reported) {
			if (result.completed) agent.facts.status = 'completed';
			if (!seeding) reportLive(bound, agent);
			return;
		}
		if (result.completed) finishAgent(bound, agent, 'completed');
	};

	// Binding.

	const newBound = (entry: IndexEntry): Bound => ({
		id: entry.sessionId,
		pid: entry.pid,
		cwd: entry.cwd,
		openedAt: entry.openedAt,
		events: initialEventsState(),
		chat: {},
		promptTitled: false,
		agents: new Map(),
		spawns: new Map(),
		childChats: new Map(),
		relocating: false,
		closes: new Map(),
		released: false,
	});

	/**
	 * Follow a session directory. With `seed`, what is already in its files sets titles,
	 * model, subagents and activity without being replayed as live events; each tail hands
	 * those records over separately, so each file is read once.
	 */
	const attachDir = async (bound: Bound, dir: string, seed: boolean): Promise<void> => {
		if (!ctx || bound.released) return;
		detachFiles(bound);
		bound.dir = dir;
		const opts = seed ? { backlog: 'separate' as const } : undefined;
		const chatTail = ctx.tailJsonl(join(dir, 'chat_history.jsonl'), opts);
		bound.closes.set('chat', () => chatTail.close());
		const eventsTail = ctx.tailJsonl(join(dir, 'events.jsonl'), opts);
		bound.closes.set('events', () => eventsTail.close());
		const summary = ctx.watchFile(join(dir, 'summary.json'), (change) => {
			if (change.type === 'change') void refreshSummary(bound, dir);
		});
		bound.closes.set('summary', () => summary.close());
		if (seed) {
			let chat: unknown[] = [];
			let events: unknown[] = [];
			try {
				[chat, events] = await Promise.all([chatTail.backlog, eventsTail.backlog]);
			} catch (error) {
				if (!bound.released) ctx?.reportError(error);
			}
			// Torn down, or moved to another directory, while the backlog was being read.
			if (!ctx || bound.released || bound.dir !== dir) return;
			for (const rec of chat) {
				try {
					handleChat(bound, rec, undefined, true);
				} catch (error) {
					ctx.reportError(error);
				}
			}
			const replay = replayEvents(events, bound.chatError);
			bound.events = replay.state;
			reportModel(bound, replay.state.model);
			ctx.emit('activity:replay', { id: bound.id, facts: replay.facts });
			if (bound.events.turnOpen) {
				// Rewound before we were watching: the log is the only place that says so.
				const rewinds = await recentRewinds(ctx.fs, logPath(homeOf()));
				if (!ctx || bound.released || bound.dir !== dir) return;
				for (const rewind of rewinds) {
					if (rewind.sessionId === bound.id) endRewound(bound, rewind);
				}
			}
			applyStatus(bound);
		}
		consume(bound, chatTail, (rec) => handleChat(bound, rec, undefined, false));
		consume(bound, eventsTail, (rec) => handleEvent(bound, rec));
		const subs = watchSubagents(bound, join(dir, 'subagents'), seed);
		if (!subs) return;
		bound.closes.set('subagents', () => subs.close());
		await subs.seeded;
		if (!ctx || bound.released || bound.dir !== dir) return;
		if (seed) reportSeeded(bound);
	};

	const refreshSummary = async (bound: Bound, dir: string): Promise<void> => {
		if (!ctx) return;
		const summary = await readSummary(ctx.fs, dir);
		if (!ctx || bound.released || bound.dir !== dir) return;
		reportSummary(bound, summary);
	};

	/**
	 * The directory is not where the index says yet: a new session before its first
	 * write, or one whose cwd moved. Watch where it will be.
	 */
	const awaitDir = (bound: Bound): void => {
		if (!ctx || bound.released) return;
		bound.closes.get('pending')?.();
		bound.closes.delete('pending');
		const derived = derivedSessionDir(homeOf(), bound.cwd, bound.id);
		if (!derived) return;
		let done = false;
		const handle = ctx.watchDir(derived, () => {
			if (done) return;
			done = true;
			void inOrder(async () => {
				if (closed || bound.released || bound.dir === derived) return;
				bound.closes.get('pending')?.();
				bound.closes.delete('pending');
				const moved = bound.dir != null;
				bound.relocating = false;
				await attachDir(bound, derived, moved);
			});
		});
		bound.closes.set('pending', () => handle.close());
	};

	const bind = async (entry: IndexEntry): Promise<void> => {
		if (!ctx) return;
		const fs = ctx.fs;
		const home = homeOf();
		const dir = await resolveSessionDir(fs, home, entry.sessionId, entry.cwd);
		const summary = dir ? await readSummary(fs, dir) : undefined;
		// Unwatched while the directory was being found.
		if (!ctx || closed) return;
		if (isSubagentKind(summary?.sessionKind)) {
			notRoots.add(entry.sessionId);
			return;
		}
		const bound = newBound(entry);
		bounds.set(bound.id, bound);
		followLog();
		ctx.emit(dir ? 'session:open' : 'session:create', {
			id: bound.id,
			harness: HARNESS,
			provider: PROVIDER,
			pid: bound.pid,
			cwd: bound.cwd,
			startedAt: summary?.startedAt ?? entry.openedAt,
			updatedAt: summary?.updatedAt,
			kind: summary?.kind ?? 'interactive',
			model: summary?.model,
		});
		bound.model = summary?.model;
		reportSummary(bound, summary);
		acquireProcess(bound);
		if (dir) {
			await attachDir(bound, dir, true);
		} else {
			applyStatus(bound);
			awaitDir(bound);
		}
	};

	/** Same session, new cwd: follow its directory to the new place once it is there. */
	const relocate = async (bound: Bound): Promise<void> => {
		if (!ctx || bound.released) return;
		const dir = await resolveSessionDir(ctx.fs, homeOf(), bound.id, bound.cwd);
		if (!ctx || bound.released) return;
		if (dir && dir !== bound.dir) {
			bound.relocating = false;
			bound.closes.get('pending')?.();
			bound.closes.delete('pending');
			await attachDir(bound, dir, true);
			return;
		}
		const derived = derivedSessionDir(homeOf(), bound.cwd, bound.id);
		bound.relocating = derived != null && derived !== bound.dir;
		if (bound.relocating) awaitDir(bound);
	};

	const readIndex = async (): Promise<IndexEntry[] | undefined> => {
		if (!ctx) return undefined;
		const path = indexPath(homeOf());
		try {
			return parseIndex(await ctx.fs.readFile(path, { maxBytes: INDEX_MAX_BYTES }));
		} catch (error) {
			if (error instanceof TooLargeError) return undefined;
			// Gone: every session in it is too. Unreadable for another reason: change nothing.
			return (await ctx.fs.stat(path).catch(() => undefined)) === null ? [] : undefined;
		}
	};

	const revalidate = async (pid?: number): Promise<void> => {
		if (!ctx) return;
		for (const bound of [...bounds.values()]) {
			if (pid != null && bound.pid !== pid) continue;
			const info = await ctx.processInfo(bound.pid);
			if (!info.alive && !bound.released) closeBound(bound);
		}
	};

	const serviceIndex = async (): Promise<void> => {
		if (!ctx || closed) return;
		const entries = await readIndex();
		if (!ctx || closed || !entries) return;
		if (processWatchUnsupported) await revalidate();
		const infos = new Map<number, Promise<ProcessInfo>>();
		const accepted = new Map<string, IndexEntry>();
		const present = new Set<string>();
		for (const entry of entries) {
			const key = entryKey(entry);
			present.add(key);
			if (stale.has(key) || accepted.has(entry.sessionId)) continue;
			let info = infos.get(entry.pid);
			if (!info) {
				info = ctx.processInfo(entry.pid);
				infos.set(entry.pid, info);
			}
			if (acceptEntry(entry, await info)) accepted.set(entry.sessionId, entry);
		}
		if (!ctx || closed) return;
		for (const key of [...stale]) if (!present.has(key)) stale.delete(key);
		for (const id of [...notRoots]) if (!accepted.has(id)) notRoots.delete(id);
		for (const bound of [...bounds.values()]) {
			const entry = accepted.get(bound.id);
			if (!entry || entry.pid !== bound.pid) closeBound(bound);
		}
		for (const entry of accepted.values()) {
			if (closed) return;
			if (notRoots.has(entry.sessionId)) continue;
			const bound = bounds.get(entry.sessionId);
			if (!bound) {
				await bind(entry);
				continue;
			}
			// Registered again (a load or resume) by the same process.
			bound.openedAt = entry.openedAt;
			if (entry.cwd !== bound.cwd) {
				bound.cwd = entry.cwd;
				ctx?.emit('session:update', { id: bound.id, cwd: entry.cwd });
				await relocate(bound);
			} else if (bound.relocating) {
				await relocate(bound);
			}
		}
	};

	// History.

	const sessionDirFor = (fs: Fs, id: string): Promise<string | undefined> =>
		resolveSessionDir(fs, homeOf(), id);

	const subagentDir = async (
		fs: Fs,
		sessionId: string,
		subagentId: string,
	): Promise<string | undefined> => {
		const root = await sessionDirFor(fs, sessionId);
		let meta: SubagentMeta | undefined;
		if (root) {
			try {
				meta = parseMeta(
					await fs.readFile(join(root, 'subagents', subagentId, 'meta.json'), {
						maxBytes: META_MAX_BYTES,
					}),
				);
			} catch {}
		}
		const childId = meta?.childSessionId ?? subagentId;
		const derived = meta?.childCwd
			? derivedSessionDir(homeOf(), meta.childCwd, childId)
			: undefined;
		if (derived && (await fs.stat(derived).catch(() => null))?.isDirectory) return derived;
		return resolveSessionDir(fs, homeOf(), childId);
	};

	return {
		id: PROVIDER,
		harness: HARNESS,
		async watch(watchCtx) {
			ctx = watchCtx;
			closed = false;
			const index = watchCtx.watchFile(indexPath(homeOf()), () => {
				if (!closed) void inOrder(serviceIndex);
			});

			await inOrder(serviceIndex);
			await drain();
			return () => {
				closed = true;
				index.close();
				for (const bound of [...bounds.values()]) teardown(bound);
				for (const entry of pidWatches.values()) entry.handle?.stop();
				pidWatches.clear();
				ctx = undefined;
			};
		},
		async revalidate(watchCtx, pid) {
			ctx ??= watchCtx;
			await revalidate(pid);
		},
		async *list(listCtx: ListContext) {
			yield* listSessions(listCtx.fs, homeOf(), { since: listCtx.since, id: listCtx.id });
		},
		async *inspect(inspectCtx: InspectContext, id: string): AsyncIterable<SessionEvent> {
			const dir = inspectCtx.subagentId
				? await subagentDir(inspectCtx.fs, id, inspectCtx.subagentId)
				: await sessionDirFor(inspectCtx.fs, id);
			if (!dir) return;
			const path = join(dir, 'chat_history.jsonl');
			const state: ChatMapState = {};
			if (inspectCtx.follow) {
				const tail = tailJsonl(inspectCtx.fs, path);
				const stop = (): void => tail.close();
				inspectCtx.signal?.addEventListener('abort', stop, { once: true });
				if (inspectCtx.signal?.aborted) stop();
				try {
					for await (const rec of tail) {
						const mapped = mapChatRecord(rec, state);
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
				yield* mapChatRecord(rec, state);
			}
		},
		async subagents(inspectCtx, sessionId) {
			const root = await sessionDirFor(inspectCtx.fs, sessionId);
			if (!root) return [];
			const dir = join(root, 'subagents');
			let names: string[];
			try {
				names = await inspectCtx.fs.readDir(dir);
			} catch {
				return [];
			}
			const out: SubagentFacts[] = [];
			for (const name of names) {
				let meta: SubagentMeta | undefined;
				try {
					const hasOutput = Boolean(
						(await inspectCtx.fs.stat(join(dir, name, 'output.json')).catch(() => null))?.isFile,
					);
					meta = parseMeta(
						await inspectCtx.fs.readFile(join(dir, name, 'meta.json'), {
							maxBytes: META_MAX_BYTES,
						}),
						hasOutput,
					);
				} catch {
					continue;
				}
				if (!meta) continue;
				const facts: SubagentFacts = {
					id: meta.subagentId,
					sessionId,
					harness: HARNESS,
					type: meta.type,
					background: false,
					// Not live: one still marked running did not outlive its session.
					status: meta.status === 'running' ? 'cancelled' : meta.status,
				};
				if (meta.title) facts.title = meta.title;
				if (meta.parentSessionId && meta.parentSessionId !== sessionId) {
					facts.parentId = meta.parentSessionId;
				}
				if (meta.startedAt != null) facts.startedAt = meta.startedAt;
				if (meta.endedAt != null) facts.endedAt = meta.endedAt;
				out.push(facts);
			}
			return out;
		},
	};
}
