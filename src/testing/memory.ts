import type { Provider, SessionInput, WatchContext } from '../provider.ts';
import type { SessionEvent, SessionSnapshot, SubagentFacts } from '../types.ts';
import type { FixtureDriver } from './driver.ts';

export function createMemoryHarness(): {
	provider: Provider;
	driver: FixtureDriver;
} {
	let ctx: WatchContext | undefined;
	const live = new Map<string, SessionInput>();
	const byPid = new Map<number, string>();
	const history: SessionSnapshot[] = [];
	const journals = new Map<string, SessionEvent[]>();
	const kids = new Map<string, SubagentFacts[]>();

	const emitLive = (input: SessionInput, verb: 'session:create' | 'session:open'): void => {
		live.set(input.id, input);
		if (input.pid != null) byPid.set(input.pid, input.id);
		ctx?.emit(verb, input);
		if (input.status) ctx?.emit('session:status', { id: input.id, status: input.status });
		if (input.title) ctx?.emit('title', { id: input.id, title: input.title, source: 'process' });
	};

	const provider: Provider = {
		id: 'memory',
		harness: 'Memory',
		watch(c) {
			ctx = c;
			for (const row of live.values()) emitLive(row, 'session:open');
			return () => {
				ctx = undefined;
			};
		},
		async *list() {
			const seen = new Set<string>();
			for (const row of live.values()) {
				seen.add(row.id);
				yield {
					id: row.id,
					harness: row.harness,
					provider: row.provider,
					cwd: row.cwd,
					title: row.title,
					startedAt: row.startedAt,
					updatedAt: row.updatedAt,
					kind: row.kind,
				};
			}
			for (const row of history) {
				if (!seen.has(row.id)) yield row;
			}
		},
		async *inspect(_c, id) {
			yield* journals.get(id) ?? [];
		},
		async revalidate(c, pid) {
			for (const [id, row] of live) {
				if (pid != null && row.pid !== pid) continue;
				if (row.pid == null) continue;
				const info = await c.processInfo(row.pid);
				if (!info.alive) {
					c.emit('session:close', { id });
					history.push({
						id,
						harness: row.harness,
						provider: row.provider,
						cwd: row.cwd,
						title: row.title,
						startedAt: row.startedAt,
						updatedAt: row.updatedAt,
						kind: row.kind,
					});
					live.delete(id);
				}
			}
		},
		async subagents(_c, sessionId) {
			return kids.get(sessionId) ?? [];
		},
	};

	const driver: FixtureDriver = {
		async createLiveSession(opts) {
			emitLive(
				{
					id: opts.id,
					harness: 'Memory',
					provider: 'memory',
					pid: opts.pid,
					cwd: opts.cwd,
					title: opts.title,
					status:
						opts.status === 'busy' ? 'running' : opts.status === 'waiting' ? 'waiting' : 'idle',
					kind: 'interactive',
				},
				journals.has(opts.id) ? 'session:open' : 'session:create',
			);
		},
		async rewriteStatus(id, status) {
			const mapped = status === 'busy' ? 'running' : status === 'waiting' ? 'waiting' : 'idle';
			const row = live.get(id);
			if (row) row.status = mapped;
			ctx?.emit('session:status', { id, status: mapped });
		},
		async switchConversation(pid, newId) {
			const old = byPid.get(pid);
			if (old) {
				ctx?.emit('session:close', { id: old });
				const row = live.get(old);
				if (row) {
					history.push({
						id: old,
						harness: row.harness,
						provider: row.provider,
						cwd: row.cwd,
						title: row.title,
					});
					live.delete(old);
				}
			}
			await this.createLiveSession({ id: newId, pid });
		},
		async updateMetadata(id, patch) {
			const row = live.get(id);
			if (row && patch.cwd) row.cwd = patch.cwd;
			if (patch.cwd) ctx?.emit('session:update', { id, cwd: patch.cwd });
			if (patch.title) ctx?.emit('title', { id, title: patch.title, source: 'user' });
		},
		async remove(id) {
			ctx?.emit('session:close', { id });
			const row = live.get(id);
			if (row) {
				history.push({
					id,
					harness: row.harness,
					provider: row.provider,
					cwd: row.cwd,
					title: row.title,
				});
				live.delete(id);
			}
		},
		async addJournal(id, records) {
			const events = journals.get(id) ?? [];
			for (const rec of records) events.push({ kind: 'other', raw: rec });
			journals.set(id, events);
		},
		async runTurnWithTool(id) {
			ctx?.emit('turn', { sessionId: id, type: 'turn-started' });
			ctx?.emit('turn', { sessionId: id, type: 'tool-started', id: 't1', name: 'Bash' });
			ctx?.emit('turn', { sessionId: id, type: 'tool-finished', id: 't1' });
			ctx?.emit('turn', {
				sessionId: id,
				type: 'turn-ended',
				outcome: 'completed',
				endedAt: Date.now(),
			});
		},
		async failTurn(id) {
			ctx?.emit('turn', { sessionId: id, type: 'turn-started' });
			ctx?.emit('turn', {
				sessionId: id,
				type: 'turn-ended',
				outcome: 'failed',
				error: 'api',
				endedAt: Date.now(),
			});
		},
		async launchForegroundSubagent(id) {
			const subagentId = `fg-${id}`;
			const facts: SubagentFacts = {
				id: subagentId,
				sessionId: id,
				harness: 'Memory',
				type: 'Explore',
				background: false,
				status: 'running',
			};
			kids.set(id, [...(kids.get(id) ?? []), facts]);
			ctx?.emit('subagent:start', facts);
			return { subagentId };
		},
		async finishForegroundSubagent(id, subagentId) {
			ctx?.emit('subagent:end', { sessionId: id, id: subagentId, status: 'completed' });
		},
		async launchBackgroundSubagent(id) {
			const subagentId = `bg-${id}`;
			const facts: SubagentFacts = {
				id: subagentId,
				sessionId: id,
				harness: 'Memory',
				type: 'Explore',
				background: true,
				status: 'running',
			};
			kids.set(id, [...(kids.get(id) ?? []), facts]);
			ctx?.emit('subagent:start', facts);
			return { subagentId };
		},
		async finishBackgroundSubagent(id, subagentId) {
			ctx?.emit('subagent:end', { sessionId: id, id: subagentId, status: 'completed' });
		},
		async launchNestedSubagent(id, parentSubagentId) {
			const subagentId = `nested-${parentSubagentId}`;
			const facts: SubagentFacts = {
				id: subagentId,
				sessionId: id,
				parentId: parentSubagentId,
				harness: 'Memory',
				type: 'Explore',
				background: false,
				status: 'running',
			};
			kids.set(id, [...(kids.get(id) ?? []), facts]);
			ctx?.emit('subagent:start', facts);
			return { subagentId };
		},
		async relocateJournal(id, newCwd) {
			ctx?.emit('session:update', { id, cwd: newCwd });
		},
	};

	return { provider, driver };
}
