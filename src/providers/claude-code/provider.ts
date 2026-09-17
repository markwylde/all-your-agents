import { basename, join } from 'node:path';
import { decodeUtf8 } from '../../helpers/bytes.js';
import { tailJsonl } from '../../helpers/tail-jsonl.js';
import type { ProcessWatchHandle } from '../../helpers/types.js';
import type { InspectContext, ListContext, Provider, WatchContext } from '../../provider.js';
import type { SessionActivity, SessionEvent, SubagentFacts, TurnFact } from '../../types.js';
import { closeOpenTurn, turnFactsFromRecord } from './activity.js';
import {
	isTaskNotification,
	mapRecord,
	parseTaskNotification,
	recordTime,
	resolveJournal,
	toolResultText,
} from './journal.js';
import { listSessions } from './list.js';
import { claudeHome, type PathOptions, sessionsDir, subagentsDir } from './paths.js';
import {
	type ParsedSessionFile,
	parseSessionFile,
	SESSION_FILE_MAX_BYTES,
} from './session-file.js';
import { isIdleWord, mapStatus } from './status.js';

type Bound = {
	pid: number;
	filePath: string;
	session: ParsedSessionFile;
	processWatch?: ProcessWatchHandle;
	journalPath?: string;
	journalClose?: () => void;
	subClose?: () => void;
	childCloses: Map<string, () => void>;
	toolUseToAgent: Map<string, string>;
	agents: Map<string, SubagentFacts>;
	stale: boolean;
	activity: SessionActivity;
	openTool?: { id: string; name: string };
};

export function claudeCode(options: PathOptions = {}): Provider {
	let ctx: WatchContext | undefined;
	const bounds = new Map<number, Bound>();
	const staleFiles = new Set<string>();
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

	const teardown = (bound: Bound, markStale: boolean): void => {
		bound.journalClose?.();
		bound.subClose?.();
		for (const close of bound.childCloses.values()) close();
		bound.childCloses.clear();
		bound.processWatch?.stop();
		bounds.delete(bound.pid);
		if (markStale) staleFiles.add(bound.filePath);
	};

	function collectFacts(records: unknown[], cutoff?: number): TurnFact[] {
		const facts: TurnFact[] = [];
		let openTool = false;
		for (const rec of records) {
			const at =
				rec && typeof rec === 'object' ? recordTime(rec as Record<string, unknown>) : undefined;
			const skipOpen = cutoff != null && at != null && at <= cutoff;
			for (const fact of turnFactsFromRecord(rec)) {
				if (skipOpen && (fact.type === 'tool-started' || fact.type === 'turn-started')) {
					facts.push(fact);
					facts.push(closeOpenTurn(true, at));
					openTool = false;
					continue;
				}
				facts.push(fact);
				if (fact.type === 'tool-started') openTool = true;
				if (fact.type === 'tool-finished' || fact.type === 'turn-ended') openTool = false;
			}
		}
		if (cutoff != null && openTool) facts.push(closeOpenTurn(true, cutoff));
		return facts;
	}

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
			if (event.kind === 'subagent' && !fromChild) {
				const agentId = event.id;
				if (!bound.agents.has(agentId) && !bound.toolUseToAgent.has(event.id)) {
					const facts: SubagentFacts = {
						id: agentId,
						sessionId: bound.session.sessionId,
						harness: 'ClaudeCode',
						type: event.type ?? 'Agent',
						title: event.title,
						background: event.background === true,
						status: 'running',
					};
					bound.agents.set(agentId, facts);
					bound.toolUseToAgent.set(event.id, agentId);
					ctx.emit('subagent:start', facts);
				} else if (!bound.agents.has(agentId)) {
					const existingId = bound.toolUseToAgent.get(event.id);
					if (existingId && bound.agents.has(existingId)) {
						/* already started via meta */
					}
				}
			}
		}
		if (fromChild) {
			const nested = mapRecord(rec).filter((e) => e.kind === 'subagent');
			for (const event of nested) {
				if (event.kind !== 'subagent') continue;
				if (bound.agents.has(event.id) || bound.toolUseToAgent.has(event.id)) continue;
				const facts: SubagentFacts = {
					id: event.id,
					sessionId: bound.session.sessionId,
					parentId: fromChild,
					harness: 'ClaudeCode',
					type: event.type ?? 'Agent',
					title: event.title,
					background: event.background === true,
					status: 'running',
				};
				bound.agents.set(event.id, facts);
				bound.toolUseToAgent.set(event.id, event.id);
				ctx.emit('subagent:start', facts);
			}
		}
		const content = (row.message as { content?: unknown } | undefined)?.content ?? row.content;
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
		const text =
			typeof content === 'string'
				? content
				: Array.isArray(content)
					? content
							.map((p) =>
								p && typeof p === 'object' && (p as { type?: string }).type === 'text'
									? String((p as { text?: string }).text ?? '')
									: '',
							)
							.join('')
					: undefined;
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

	const attachJournal = async (
		bound: Bound,
		path: string,
		silent: boolean,
		cutoff?: number,
	): Promise<void> => {
		if (!ctx) return;
		bound.journalClose?.();
		bound.journalPath = path;
		const records: unknown[] = [];
		const st = await ctx.fs.stat(path);
		if (st) {
			const bytes = await ctx.fs.readRange(path, 0, st.size);
			for (const line of decodeUtf8(bytes).split('\n')) {
				if (!line.trim()) continue;
				try {
					records.push(JSON.parse(line));
				} catch {
					// skip
				}
			}
		}
		if (silent) {
			for (const rec of records) handleSeedRecord(bound, rec);
			ctx.emit('activity:replay', {
				id: bound.session.sessionId,
				facts: collectFacts(
					records,
					isIdleWord(bound.session.status) ? bound.session.statusUpdatedAt : cutoff,
				),
			});
		}
		const tail = ctx.tailJsonl(path);
		bound.journalClose = () => tail.close();
		void (async () => {
			let skipping = silent ? records.length : 0;
			try {
				for await (const rec of tail) {
					if (skipping > 0) {
						skipping--;
						continue;
					}
					handleRecord(bound, rec);
				}
			} catch {
				// closed
			}
		})();
		await attachSubagentsDir(bound, path);
	};

	function handleSeedRecord(bound: Bound, rec: unknown): void {
		if (!rec || typeof rec !== 'object') return;
		for (const event of mapRecord(rec)) {
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
		if (!ctx) return;
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
		const name = basename(path);
		const agentId = name.replace(/^agent-/, '').replace(/\.meta\.json$/, '');
		const toolUseId = typeof rec.toolUseId === 'string' ? rec.toolUseId : undefined;
		if (toolUseId) bound.toolUseToAgent.set(toolUseId, agentId);
		if (bound.agents.has(agentId)) return;
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
		if (!ctx || bound.childCloses.has(name)) return;
		const agentId = name.replace(/^agent-/, '').replace(/\.jsonl$/, '');
		const tail = ctx.tailJsonl(path);
		bound.childCloses.set(name, () => tail.close());
		void (async () => {
			try {
				for await (const rec of tail) handleRecord(bound, rec, agentId);
			} catch {
				// closed
			}
		})();
	};

	const bind = async (filePath: string, parsed: ParsedSessionFile): Promise<void> => {
		if (!ctx) return;
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
			teardown(byPid, false);
		}
		const journal = parsed.cwd
			? await resolveJournal(ctx.fs, homeOf(), parsed.sessionId, parsed.cwd)
			: await resolveJournal(ctx.fs, homeOf(), parsed.sessionId);
		const bound: Bound = {
			pid: parsed.pid,
			filePath,
			session: parsed,
			childCloses: new Map(),
			toolUseToAgent: new Map(),
			agents: new Map(),
			stale: false,
			activity: { openSubagents: 0 },
		};
		bounds.set(parsed.pid, bound);
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
			teardown(current, true);
		});
		if (watch === 'unsupported') processWatchUnsupported = true;
		else bound.processWatch = watch;
		if (journal) await attachJournal(bound, journal, true);
	};

	const rewrite = async (bound: Bound, parsed: ParsedSessionFile): Promise<void> => {
		if (!ctx) return;
		if (parsed.sessionId !== bound.session.sessionId) {
			emitClose(bound);
			teardown(bound, false);
			await bind(bound.filePath, parsed);
			return;
		}
		const prev = bound.session;
		bound.session = parsed;
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
			const bound = bounds.get(filenamePid);
			if (bound) {
				emitClose(bound);
				teardown(bound, false);
			}
			return;
		}
		const info = await ctx.processInfo(filenamePid);
		const parsed = parseSessionFile(filenamePid, bytes, info);
		if (!parsed) return;
		staleFiles.delete(path);
		await bind(path, parsed);
	};

	const revalidate = async (pid?: number): Promise<void> => {
		if (!ctx) return;
		for (const bound of [...bounds.values()]) {
			if (pid != null && bound.pid !== pid) continue;
			const info = await ctx.processInfo(bound.pid);
			if (!info.alive) {
				emitClose(bound);
				teardown(bound, true);
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
			const pending: Promise<void>[] = [];
			const watcher = watchCtx.watchDir(dir, (event) => {
				if (closed) return;
				if (event.type === 'delete') {
					const pid = Number(basename(event.path).replace(/\.json$/, ''));
					const bound = bounds.get(pid);
					if (bound) {
						emitClose(bound);
						teardown(bound, false);
					}
					return;
				}
				pending.push(
					(async () => {
						await serviceFile(event.path);
						if (processWatchUnsupported) await revalidate();
					})(),
				);
			});
			await watcher.ready;
			await Promise.all(pending);
			return () => {
				closed = true;
				watcher.close();
				for (const bound of [...bounds.values()]) teardown(bound, false);
				ctx = undefined;
			};
		},
		async revalidate(watchCtx, pid) {
			ctx = watchCtx;
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
				try {
					for await (const rec of tail) {
						const mapped = mapRecord(rec);
						if (mapped.length) yield* mapped;
						else yield { kind: 'other', raw: rec };
					}
				} finally {
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
