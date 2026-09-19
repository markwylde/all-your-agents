import { basename, dirname, join } from 'node:path';
import { decodeUtf8 } from '../../helpers/bytes.ts';
import { tailJsonl } from '../../helpers/tail-jsonl.ts';
import type { ProcessWatchHandle } from '../../helpers/types.ts';
import type { InspectContext, ListContext, Provider, WatchContext } from '../../provider.ts';
import type { SessionEvent, SubagentFacts, TurnFact } from '../../types.ts';
import { closeOpenTurn, turnFactsFromRecord } from './activity.ts';
import {
	contentOf,
	isTaskNotification,
	mapRecord,
	modelOf,
	parseTaskNotification,
	promptTitle,
	recordTime,
	resolveJournal,
	textOf,
	toolResultText,
} from './journal.ts';
import { listSessions } from './list.ts';
import {
	claudeHome,
	derivedJournalPath,
	type PathOptions,
	sessionsDir,
	subagentsDir,
} from './paths.ts';
import {
	type ParsedSessionFile,
	parseSessionFile,
	SESSION_FILE_MAX_BYTES,
} from './session-file.ts';
import { isIdleWord, mapStatus } from './status.ts';

type Bound = {
	pid: number;
	filePath: string;
	session: ParsedSessionFile;
	processWatch?: ProcessWatchHandle;
	journalPath?: string;
	journalClose?: () => void;
	pendingJournalClose?: () => void;
	subClose?: () => void;
	childCloses: Map<string, () => void>;
	toolUseToAgent: Map<string, string>;
	agents: Map<string, SubagentFacts>;
	openTool?: { id: string; name: string };
	model?: string;
	/** A `prompt` title has been reported; only the first real prompt is one. */
	promptTitled: boolean;
	/** Torn down. Work that was awaiting when that happened must not attach anything. */
	released: boolean;
};

type Tail = AsyncIterable<unknown> & { close(): void };

export function claudeCode(options: PathOptions = {}): Provider {
	let ctx: WatchContext | undefined;
	const bounds = new Map<number, Bound>();
	/**
	 * Interactive session files whose conversation a live background job has taken over
	 * (`parkedJobId` names that job's `jobId`). The job's row carries the conversation;
	 * these are serviced again when the job goes away.
	 */
	const parked = new Map<number, { filePath: string; jobId: string }>();
	/**
	 * Parked files seen during the initial scan, before their job's file may have been
	 * read. They are serviced once the scan is done, so a parked terminal never opens
	 * only to be closed a moment later.
	 */
	const deferred = new Set<string>();
	let scanning = false;
	let processWatchUnsupported = false;
	let closed = false;

	const homeOf = (): string => claudeHome(options);

	const emitClose = (bound: Bound): void => {
		for (const rec of bound.agents.values()) {
			if (rec.status === 'running') {
				ctx?.emit('subagent:end', {
					sessionId: bound.session.sessionId,
					id: rec.id,
					status: 'cancelled',
				});
				rec.status = 'cancelled';
			}
		}
		ctx?.emit('session:close', { id: bound.session.sessionId });
	};

	const teardown = (bound: Bound): void => {
		bound.released = true;
		bound.journalClose?.();
		bound.pendingJournalClose?.();
		bound.subClose?.();
		for (const close of bound.childCloses.values()) close();
		bound.childCloses.clear();
		bound.processWatch?.stop();
		bounds.delete(bound.pid);
		const jobId = bound.session.jobId;
		if (jobId && !closed) {
			for (const [pid, entry] of parked) {
				if (entry.jobId !== jobId) continue;
				parked.delete(pid);
				void inOrder(entry.filePath, () => serviceFile(entry.filePath));
			}
		}
	};

	const liveJob = (jobId: string, pid: number): Bound | undefined =>
		[...bounds.values()].find((b) => b.pid !== pid && b.session.jobId === jobId);

	const park = (bound: Bound, jobId: string): void => {
		emitClose(bound);
		teardown(bound);
		parked.set(bound.pid, { filePath: bound.filePath, jobId });
	};

	/**
	 * Turn facts for a bind replay. Records at or before `cutoff` (when the session file
	 * last went idle) must not leave a turn or tool open, so a turn still open when the
	 * replay passes the cutoff is closed there, once. Closing after every start instead
	 * would record a synthetic end before the turn's real end, and the core keeps the
	 * first end of a turn.
	 */
	function collectFacts(records: unknown[], cutoff?: number): TurnFact[] {
		const facts: TurnFact[] = [];
		let openTool = false;
		let openTurn = false;
		let pastCutoff = cutoff == null;
		const closeOpen = (at: number | undefined): void => {
			if (!openTool && !openTurn) return;
			facts.push(closeOpenTurn(openTool, at));
			openTool = false;
			openTurn = false;
		};
		for (const rec of records) {
			const at =
				rec && typeof rec === 'object' ? recordTime(rec as Record<string, unknown>) : undefined;
			if (!pastCutoff && cutoff != null && at != null && at > cutoff) {
				closeOpen(cutoff);
				pastCutoff = true;
			}
			for (const fact of turnFactsFromRecord(rec)) {
				facts.push(fact);
				if (fact.type === 'turn-started') openTurn = true;
				if (fact.type === 'tool-started') {
					openTool = true;
					openTurn = true;
				}
				if (fact.type === 'tool-finished') openTool = false;
				if (fact.type === 'turn-ended') {
					openTool = false;
					openTurn = false;
				}
			}
		}
		if (!pastCutoff) closeOpen(cutoff);
		else if (cutoff != null && openTool) facts.push(closeOpenTurn(true, cutoff));
		return facts;
	}

	const reportPromptTitle = (bound: Bound, text: string): void => {
		if (bound.promptTitled) return;
		bound.promptTitled = true;
		ctx?.emit('title', { id: bound.session.sessionId, title: promptTitle(text), source: 'prompt' });
	};

	const reportModel = (bound: Bound, model: string | undefined): void => {
		if (!model || model === bound.model) return;
		bound.model = model;
		ctx?.emit('session:update', { id: bound.session.sessionId, model });
	};

	/**
	 * Handle every record a tail yields until it closes. One record that cannot be
	 * handled is reported and skipped; it must not end the tail.
	 */
	const consume = (bound: Bound, tail: Tail, handle: (rec: unknown) => void): void => {
		void (async () => {
			try {
				for await (const rec of tail) {
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

	const handleRecord = (bound: Bound, rec: unknown, fromChild?: string): void => {
		if (!ctx || !rec || typeof rec !== 'object') return;
		const row = rec as Record<string, unknown>;
		for (const event of mapRecord(rec)) {
			if (event.kind === 'title') {
				ctx.emit('title', {
					id: bound.session.sessionId,
					title: event.title,
					source: event.source,
				});
			}
			if (event.kind === 'user' && !fromChild) reportPromptTitle(bound, event.text);
			// A launch seen in a child journal is a nested subagent. One already known by
			// this id, or through its meta file, has started.
			if (event.kind === 'subagent') {
				if (bound.agents.has(event.id) || bound.toolUseToAgent.has(event.id)) continue;
				const facts: SubagentFacts = {
					id: event.id,
					sessionId: bound.session.sessionId,
					harness: 'ClaudeCode',
					type: event.type ?? 'Agent',
					title: event.title,
					background: event.background === true,
					status: 'running',
				};
				if (fromChild) facts.parentId = fromChild;
				bound.agents.set(event.id, facts);
				bound.toolUseToAgent.set(event.id, event.id);
				ctx.emit('subagent:start', facts);
			}
		}
		if (!fromChild) reportModel(bound, modelOf(rec));
		const content = contentOf(row);
		if (row.type === 'user' && Array.isArray(content)) {
			for (const part of content) {
				if (!part || typeof part !== 'object') continue;
				const p = part as Record<string, unknown>;
				if (p.type !== 'tool_result' || typeof p.tool_use_id !== 'string') continue;
				const agentId = bound.toolUseToAgent.get(p.tool_use_id);
				const recAgent = agentId ? bound.agents.get(agentId) : undefined;
				if (recAgent?.status !== 'running') continue;
				const text = toolResultText(p);
				if (recAgent.background && text.includes('Async agent launched')) continue;
				const status = p.is_error === true ? 'failed' : 'completed';
				recAgent.status = status;
				ctx.emit('subagent:end', {
					sessionId: bound.session.sessionId,
					id: recAgent.id,
					status,
				});
			}
		}
		const text = textOf(content);
		if (row.type === 'user' && text && isTaskNotification(row, text)) {
			const parsed = parseTaskNotification(text);
			if (parsed.toolUseId && parsed.status) {
				const agentId = bound.toolUseToAgent.get(parsed.toolUseId);
				const recAgent = agentId ? bound.agents.get(agentId) : undefined;
				if (recAgent && recAgent.status === 'running') {
					recAgent.status = parsed.status;
					ctx.emit('subagent:end', {
						sessionId: bound.session.sessionId,
						id: recAgent.id,
						status: parsed.status,
					});
				}
			}
		}
		if (row.type === 'system' && row.subtype === 'agents_killed') {
			for (const recAgent of bound.agents.values()) {
				if (recAgent.status !== 'running') continue;
				recAgent.status = 'cancelled';
				ctx.emit('subagent:end', {
					sessionId: bound.session.sessionId,
					id: recAgent.id,
					status: 'cancelled',
				});
			}
		}
		if (!fromChild) {
			for (const fact of turnFactsFromRecord(rec)) {
				if (fact.type === 'tool-started') bound.openTool = { id: fact.id, name: fact.name };
				if (fact.type === 'tool-finished' || fact.type === 'turn-ended') bound.openTool = undefined;
				ctx.emit('turn', { sessionId: bound.session.sessionId, ...fact });
			}
		}
	};

	/**
	 * Tail a journal. With `seed`, the records already in it set titles, model, subagents
	 * and activity without being replayed as live events; the tail hands them over
	 * separately, so the journal is read once.
	 */
	const attachJournal = async (
		bound: Bound,
		path: string,
		seed: boolean,
		cutoff?: number,
	): Promise<void> => {
		if (!ctx || bound.released) return;
		if (bound.journalPath === path && bound.journalClose) return;
		bound.pendingJournalClose?.();
		bound.pendingJournalClose = undefined;
		bound.journalClose?.();
		bound.journalPath = path;
		const tail = ctx.tailJsonl(path, seed ? { backlog: 'separate' } : undefined);
		bound.journalClose = () => tail.close();
		if (seed) {
			let records: unknown[] = [];
			try {
				records = await tail.backlog;
			} catch (error) {
				if (!bound.released) ctx?.reportError(error);
			}
			// Torn down, or moved to another journal, while the backlog was being read.
			if (!ctx || bound.released || bound.journalPath !== path) return;
			let model: string | undefined;
			for (const rec of records) {
				handleSeedRecord(bound, rec);
				model = modelOf(rec) ?? model;
			}
			reportModel(bound, model);
			ctx.emit('activity:replay', {
				id: bound.session.sessionId,
				facts: collectFacts(
					records,
					isIdleWord(bound.session.status) ? bound.session.statusUpdatedAt : cutoff,
				),
			});
		}
		consume(bound, tail, (rec) => handleRecord(bound, rec));
		await attachSubagentsDir(bound, path);
	};

	function handleSeedRecord(bound: Bound, rec: unknown): void {
		if (!rec || typeof rec !== 'object') return;
		for (const event of mapRecord(rec)) {
			if (event.kind === 'user') reportPromptTitle(bound, event.text);
			if (event.kind === 'title') {
				ctx?.emit('title', {
					id: bound.session.sessionId,
					title: event.title,
					source: event.source,
				});
			}
			if (event.kind === 'subagent') {
				const facts: SubagentFacts = {
					id: event.id,
					sessionId: bound.session.sessionId,
					harness: 'ClaudeCode',
					type: event.type ?? 'Agent',
					title: event.title,
					background: event.background === true,
					status: 'completed',
				};
				if (!bound.agents.has(event.id)) {
					bound.agents.set(event.id, facts);
					bound.toolUseToAgent.set(event.id, event.id);
					ctx?.emit('subagent:seed', facts);
				}
			}
			if (event.kind === 'subagent-end') {
				const recAgent = bound.agents.get(event.id);
				if (recAgent) recAgent.status = event.status;
			}
		}
	}

	const attachSubagentsDir = async (bound: Bound, journalPath: string): Promise<void> => {
		if (!ctx || bound.released) return;
		bound.subClose?.();
		const dir = join(subagentsDir(journalPath), 'subagents');
		const handle = ctx.watchDir(dir, (event) => {
			if (event.name.endsWith('.meta.json')) void readMeta(bound, event.path);
			if (event.name.endsWith('.jsonl') && event.type !== 'delete') {
				void tailChild(bound, event.path, event.name);
			}
		});
		bound.subClose = () => handle.close();
	};

	const readMeta = async (bound: Bound, path: string): Promise<void> => {
		if (!ctx) return;
		let rec: Record<string, unknown>;
		try {
			rec = JSON.parse(decodeUtf8(await ctx.fs.readFile(path))) as Record<string, unknown>;
		} catch {
			return;
		}
		if (!ctx || bound.released) return;
		const name = basename(path);
		const agentId = name.replace(/^agent-/, '').replace(/\.meta\.json$/, '');
		const toolUseId = typeof rec.toolUseId === 'string' ? rec.toolUseId : undefined;
		if (toolUseId) bound.toolUseToAgent.set(toolUseId, agentId);
		if (bound.agents.has(agentId)) return;
		if (toolUseId && bound.agents.has(toolUseId)) return;
		const facts: SubagentFacts = {
			id: agentId,
			sessionId: bound.session.sessionId,
			harness: 'ClaudeCode',
			type: typeof rec.agentType === 'string' ? rec.agentType : 'Agent',
			title: typeof rec.description === 'string' ? rec.description : undefined,
			background: rec.requestShape === 'background',
			status: 'running',
			parentId: typeof rec.parentAgentId === 'string' ? rec.parentAgentId : undefined,
		};
		bound.agents.set(agentId, facts);
		ctx.emit('subagent:start', facts);
	};

	const tailChild = async (bound: Bound, path: string, name: string): Promise<void> => {
		if (!ctx || bound.released || bound.childCloses.has(name)) return;
		const agentId = name.replace(/^agent-/, '').replace(/\.jsonl$/, '');
		const tail = ctx.tailJsonl(path);
		bound.childCloses.set(name, () => tail.close());
		consume(bound, tail, (rec) => handleRecord(bound, rec, agentId));
	};

	const armPendingJournal = (bound: Bound, parsed: ParsedSessionFile): void => {
		if (!ctx || bound.released || bound.journalPath || !parsed.cwd) return;
		bound.pendingJournalClose?.();
		const derived = derivedJournalPath(homeOf(), parsed.cwd, parsed.sessionId);
		const dir = dirname(derived);
		const file = basename(derived);
		const handle = ctx.watchDir(dir, (event) => {
			if (bound.journalPath) return;
			if (event.name !== file && event.path !== derived) return;
			void attachJournal(bound, derived, false);
		});
		bound.pendingJournalClose = () => handle.close();
	};

	const bind = async (filePath: string, parsed: ParsedSessionFile): Promise<void> => {
		if (!ctx) return;
		parked.delete(parsed.pid);
		if (parsed.spare) {
			const byPid = bounds.get(parsed.pid);
			if (byPid) {
				emitClose(byPid);
				teardown(byPid);
			}
			return;
		}
		if (parsed.parkedJobId && liveJob(parsed.parkedJobId, parsed.pid)) {
			const byPid = bounds.get(parsed.pid);
			if (byPid) {
				emitClose(byPid);
				teardown(byPid);
			}
			parked.set(parsed.pid, { filePath, jobId: parsed.parkedJobId });
			return;
		}
		if (parsed.parkedJobId && scanning) {
			deferred.add(filePath);
			return;
		}
		const existing = [...bounds.values()].find(
			(b) => b.session.sessionId === parsed.sessionId && b.pid === parsed.pid,
		);
		if (existing) {
			await rewrite(existing, parsed);
			return;
		}
		const byPid = bounds.get(parsed.pid);
		if (byPid && byPid.session.sessionId !== parsed.sessionId) {
			emitClose(byPid);
			teardown(byPid);
		}
		const journal = parsed.cwd
			? await resolveJournal(ctx.fs, homeOf(), parsed.sessionId, parsed.cwd)
			: await resolveJournal(ctx.fs, homeOf(), parsed.sessionId);
		// Unwatched while the journal was being found.
		if (!ctx || closed) return;
		const bound: Bound = {
			pid: parsed.pid,
			filePath,
			session: parsed,
			childCloses: new Map(),
			toolUseToAgent: new Map(),
			agents: new Map(),
			promptTitled: false,
			released: false,
		};
		bounds.set(parsed.pid, bound);
		const jobId = parsed.jobId;
		if (jobId) {
			for (const other of [...bounds.values()]) {
				if (other !== bound && other.session.parkedJobId === jobId) park(other, jobId);
			}
		}
		const verb = journal ? 'session:open' : 'session:create';
		ctx.emit(verb, {
			id: parsed.sessionId,
			harness: 'ClaudeCode',
			provider: 'claude-code',
			pid: parsed.pid,
			cwd: parsed.cwd,
			startedAt: parsed.startedAt,
			updatedAt: parsed.updatedAt,
			kind: parsed.kind ?? 'interactive',
		});
		const mapped = mapStatus(parsed.status);
		if (mapped.status) {
			ctx.emit('session:status', {
				id: parsed.sessionId,
				status: mapped.status,
				waitingFor: parsed.status === 'waiting' ? parsed.waitingFor : undefined,
				updatedAt: parsed.statusUpdatedAt ?? parsed.updatedAt,
			});
		}
		if (parsed.name)
			ctx.emit('title', { id: parsed.sessionId, title: parsed.name, source: 'process' });
		const watch = ctx.watchProcess(parsed.pid, () => {
			if (closed) return;
			const current = bounds.get(parsed.pid);
			if (!current) return;
			emitClose(current);
			teardown(current);
		});
		if (watch === 'unsupported') processWatchUnsupported = true;
		else bound.processWatch = watch;
		if (journal) await attachJournal(bound, journal, true);
		else armPendingJournal(bound, parsed);
	};

	const rewrite = async (bound: Bound, parsed: ParsedSessionFile): Promise<void> => {
		if (!ctx) return;
		if (parsed.sessionId !== bound.session.sessionId) {
			emitClose(bound);
			teardown(bound);
			await bind(bound.filePath, parsed);
			return;
		}
		const prev = bound.session;
		bound.session = parsed;
		if (!bound.journalPath) {
			const journal = parsed.cwd
				? await resolveJournal(ctx.fs, homeOf(), parsed.sessionId, parsed.cwd)
				: await resolveJournal(ctx.fs, homeOf(), parsed.sessionId);
			if (journal) await attachJournal(bound, journal, false);
			else armPendingJournal(bound, parsed);
		}
		if (!ctx || bound.released) return;
		if (parsed.cwd && parsed.cwd !== prev.cwd) {
			ctx.emit('session:update', {
				id: parsed.sessionId,
				cwd: parsed.cwd,
				updatedAt: parsed.updatedAt,
			});
			const nextJournal = await resolveJournal(ctx.fs, homeOf(), parsed.sessionId, parsed.cwd);
			if (nextJournal && nextJournal !== bound.journalPath) {
				await attachJournal(bound, nextJournal, true, parsed.statusUpdatedAt);
			}
			if (!ctx || bound.released) return;
		}
		const mapped = mapStatus(parsed.status);
		const prevMapped = mapStatus(prev.status);
		if (mapped.status !== prevMapped.status || parsed.waitingFor !== prev.waitingFor) {
			ctx.emit('session:status', {
				id: parsed.sessionId,
				status: mapped.status,
				waitingFor: mapped.status === 'waiting' ? parsed.waitingFor : undefined,
				updatedAt: parsed.statusUpdatedAt ?? parsed.updatedAt,
			});
			if (isIdleWord(parsed.status)) {
				ctx.emit('turn', {
					sessionId: parsed.sessionId,
					...closeOpenTurn(Boolean(bound.openTool), parsed.statusUpdatedAt),
				});
				bound.openTool = undefined;
				for (const rec of bound.agents.values()) {
					if (rec.status === 'running' && !rec.background) {
						rec.status = 'cancelled';
						ctx.emit('subagent:end', {
							sessionId: parsed.sessionId,
							id: rec.id,
							status: 'cancelled',
						});
					}
				}
			}
		}
		if (parsed.name && parsed.name !== prev.name) {
			ctx.emit('title', { id: parsed.sessionId, title: parsed.name, source: 'process' });
		}
	};

	/**
	 * Events for one session file are serviced strictly in order. Binding awaits the
	 * filesystem, and a second event for the same file overtaking it (a rewrite, or the
	 * file's removal) would bind the session twice or bring a removed one back.
	 */
	const queues = new Map<string, Promise<void>>();
	const inOrder = (path: string, task: () => Promise<void>): Promise<void> => {
		const next = (queues.get(path) ?? Promise.resolve())
			.then(task)
			.catch((error: unknown) => {
				if (!closed) ctx?.reportError(error);
			})
			.finally(() => {
				if (queues.get(path) === next) queues.delete(path);
			});
		queues.set(path, next);
		return next;
	};

	const serviceFile = async (path: string): Promise<void> => {
		if (!ctx) return;
		const name = basename(path);
		if (!name.endsWith('.json')) return;
		const filenamePid = Number(name.slice(0, -'.json'.length));
		if (!Number.isFinite(filenamePid)) return;
		let bytes: Uint8Array;
		try {
			bytes = await ctx.fs.readFile(path, { maxBytes: SESSION_FILE_MAX_BYTES });
		} catch {
			parked.delete(filenamePid);
			const bound = bounds.get(filenamePid);
			if (bound) {
				emitClose(bound);
				teardown(bound);
			}
			return;
		}
		const info = await ctx.processInfo(filenamePid);
		if (!ctx || closed) return;
		const parsed = parseSessionFile(filenamePid, bytes, info);
		if (!parsed) {
			parked.delete(filenamePid);
			return;
		}
		await bind(path, parsed);
	};

	const revalidate = async (pid?: number): Promise<void> => {
		if (!ctx) return;
		for (const bound of [...bounds.values()]) {
			if (pid != null && bound.pid !== pid) continue;
			const info = await ctx.processInfo(bound.pid);
			if (!info.alive && !bound.released) {
				emitClose(bound);
				teardown(bound);
			}
		}
	};

	return {
		id: 'claude-code',
		harness: 'ClaudeCode',
		async watch(watchCtx) {
			ctx = watchCtx;
			closed = false;
			const home = homeOf();
			const dir = sessionsDir(home);
			scanning = true;
			const watcher = watchCtx.watchDir(dir, (event) => {
				if (closed) return;
				void inOrder(event.path, async () => {
					if (closed) return;
					if (event.type === 'delete') {
						const pid = Number(basename(event.path).replace(/\.json$/, ''));
						parked.delete(pid);
						deferred.delete(event.path);
						const bound = bounds.get(pid);
						if (bound) {
							emitClose(bound);
							teardown(bound);
						}
						return;
					}
					await serviceFile(event.path);
					if (processWatchUnsupported) await revalidate();
				});
			});
			await watcher.ready;
			// The initial scan has queued every session file already there.
			await Promise.all(queues.values());
			scanning = false;
			for (const path of deferred) void inOrder(path, () => serviceFile(path));
			deferred.clear();
			await Promise.all(queues.values());
			return () => {
				closed = true;
				watcher.close();
				for (const bound of [...bounds.values()]) teardown(bound);
				parked.clear();
				deferred.clear();
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
			const home = homeOf();
			let path: string | undefined;
			if (inspectCtx.subagentId) {
				const root = await resolveJournal(inspectCtx.fs, home, id);
				if (root) {
					path = join(subagentsDir(root), 'subagents', `agent-${inspectCtx.subagentId}.jsonl`);
				}
			} else {
				path = await resolveJournal(inspectCtx.fs, home, id);
			}
			if (!path) return;
			if (inspectCtx.follow) {
				const tail = tailJsonl(inspectCtx.fs, path);
				const stop = (): void => tail.close();
				inspectCtx.signal?.addEventListener('abort', stop, { once: true });
				if (inspectCtx.signal?.aborted) stop();
				try {
					for await (const rec of tail) {
						const mapped = mapRecord(rec);
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
				try {
					const rec = JSON.parse(line);
					const mapped = mapRecord(rec);
					if (mapped.length) yield* mapped;
				} catch {
					// skip
				}
			}
		},
		async subagents(inspectCtx, sessionId) {
			const home = homeOf();
			const journal = await resolveJournal(inspectCtx.fs, home, sessionId);
			if (!journal) return [];
			const dir = join(subagentsDir(journal), 'subagents');
			let names: string[] = [];
			try {
				names = await inspectCtx.fs.readDir(dir);
			} catch {
				return [];
			}
			const out: SubagentFacts[] = [];
			for (const name of names) {
				if (!name.endsWith('.meta.json')) continue;
				try {
					const rec = JSON.parse(
						decodeUtf8(await inspectCtx.fs.readFile(join(dir, name))),
					) as Record<string, unknown>;
					const id = name.replace(/^agent-/, '').replace(/\.meta\.json$/, '');
					out.push({
						id,
						sessionId,
						harness: 'ClaudeCode',
						type: typeof rec.agentType === 'string' ? rec.agentType : 'Agent',
						title: typeof rec.description === 'string' ? rec.description : undefined,
						background: rec.requestShape === 'background',
						status: 'completed',
						parentId: typeof rec.parentAgentId === 'string' ? rec.parentAgentId : undefined,
					});
				} catch {
					// skip
				}
			}
			return out;
		},
	};
}
