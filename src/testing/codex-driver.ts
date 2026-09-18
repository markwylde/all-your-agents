import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Processes } from '../helpers/types.ts';
import type { FixtureDriver } from './driver.ts';

type Held = { pid: number; cwd: string; path: string };

export function createCodexFixtureDriver(
	home: string,
	opts: { settleMs?: number } = {},
): FixtureDriver & { processes: Processes & { set(pid: number, a: boolean, t?: number): void } } {
	const settleMs = opts.settleMs ?? 80;
	const entries = new Map<string, Held>();
	const openTurns = new Set<string>();
	const childOf = new Map<string, string>();
	const start = Date.now() - 1000;
	const alive = new Map<number, { alive: boolean; startTime: number }>();
	const exits = new Map<number, () => void>();
	const open = new Map<string, Set<number>>();

	const settle = () => new Promise<void>((resolve) => setTimeout(resolve, settleMs));
	const now = () => new Date().toISOString();

	const stamp = '2026-01-01T00-00-00';
	const pathOf = (id: string, extra?: string) =>
		join(
			home,
			'sessions',
			'2026',
			'01',
			'01',
			extra ? `rollout-${stamp}-${id}_${extra}.jsonl` : `rollout-${stamp}-${id}.jsonl`,
		);

	const hold = (pid: number, path: string) => {
		const set = open.get(path) ?? new Set();
		set.add(pid);
		open.set(path, set);
	};
	const drop = (pid: number, path: string) => {
		open.get(path)?.delete(pid);
	};

	const processes: Processes & { set(pid: number, a: boolean, t?: number): void } = {
		async info(pid) {
			return alive.get(pid) ?? { alive: true, startTime: start };
		},
		watch(pid, onExit) {
			exits.set(pid, onExit);
			return {
				stop() {
					exits.delete(pid);
				},
			};
		},
		async holders(path) {
			return [...(open.get(path) ?? [])];
		},
		async heldUnder(directory) {
			const prefix = directory.endsWith('/') ? directory : `${directory}/`;
			const out: { path: string; pid: number }[] = [];
			for (const [path, pids] of open) {
				if (path !== directory && !path.startsWith(prefix)) continue;
				for (const pid of pids) out.push({ path, pid });
			}
			return out;
		},
		set(pid, a, t = start) {
			if (a) alive.set(pid, { alive: true, startTime: t });
			else alive.delete(pid);
		},
	};

	const meta = (id: string, extra: Record<string, unknown> = {}) => ({
		timestamp: now(),
		type: 'session_meta',
		payload: {
			id,
			session_id: extra.session_id ?? id,
			cwd: extra.cwd ?? '/tmp/app',
			timestamp: now(),
			source: extra.source ?? 'cli',
			originator: 'codex-tui',
			cli_version: '0.0.0',
			...extra,
		},
	});

	const append = async (path: string, records: unknown[]): Promise<void> => {
		await mkdir(dirname(path), { recursive: true });
		await appendFile(path, records.map((r) => `${JSON.stringify(r)}\n`).join(''));
	};

	const writeLines = async (path: string, records: unknown[]): Promise<void> => {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, records.map((r) => `${JSON.stringify(r)}\n`).join(''));
	};

	const event = (type: string, payload: Record<string, unknown> = {}) => ({
		timestamp: now(),
		type: 'event_msg',
		payload: { type, ...payload },
	});

	const item = (payload: Record<string, unknown>) => ({
		timestamp: now(),
		type: 'response_item',
		payload,
	});

	return {
		processes,
		async createLiveSession(o) {
			const path = pathOf(o.id);
			alive.set(o.pid, { alive: true, startTime: start });
			entries.set(o.id, { pid: o.pid, cwd: o.cwd ?? '/tmp/app', path });
			const records: unknown[] = [meta(o.id, { cwd: o.cwd ?? '/tmp/app' })];
			if (o.title) {
				await append(join(home, 'session_index.jsonl'), [
					{ id: o.id, thread_name: o.title, updated_at: now() },
				]);
			}
			const status = o.status ?? 'busy';
			if (status === 'busy') {
				records.push(event('task_started'));
				openTurns.add(o.id);
			} else if (status === 'idle') {
				records.push(event('task_complete'));
			}
			await writeLines(path, records);
			hold(o.pid, path);
			await settle();
		},
		async rewriteStatus(id, status) {
			const e = entries.get(id);
			if (!e) return;
			if (status === 'busy' || status === 'running') {
				if (!openTurns.has(id)) {
					openTurns.add(id);
					await append(e.path, [event('task_started')]);
				}
			} else if (status === 'idle') {
				openTurns.delete(id);
				await append(e.path, [event('task_complete')]);
			}
			await settle();
		},
		async switchConversation(pid, newId) {
			let cwd = '/tmp/app';
			for (const [id, e] of [...entries]) {
				if (e.pid !== pid) continue;
				cwd = e.cwd;
				drop(pid, e.path);
				entries.delete(id);
			}
			const path = pathOf(newId);
			entries.set(newId, { pid, cwd, path });
			alive.set(pid, { alive: true, startTime: start });
			await writeLines(path, [meta(newId, { cwd })]);
			hold(pid, path);
			await settle();
		},
		async updateMetadata(id, patch) {
			const e = entries.get(id);
			if (!e) return;
			if (patch.cwd) {
				e.cwd = patch.cwd;
				await append(e.path, [
					event('thread_settings_applied', { thread_settings: { cwd: patch.cwd, model: 'x' } }),
				]);
			}
			if (patch.title) {
				await append(join(home, 'session_index.jsonl'), [
					{ id, thread_name: patch.title, updated_at: now() },
				]);
			}
			await settle();
		},
		async remove(id) {
			const e = entries.get(id);
			if (!e) return;
			drop(e.pid, e.path);
			entries.delete(id);
			openTurns.delete(id);
			await append(e.path, [event('token_count')]);
			await settle();
		},
		async addJournal(id, records) {
			const e = entries.get(id);
			if (!e) return;
			await append(e.path, records);
			await settle();
		},
		async runTurnWithTool(id) {
			const e = entries.get(id);
			if (!e) return;
			if (!openTurns.has(id)) {
				openTurns.add(id);
				await append(e.path, [event('task_started')]);
			}
			await append(e.path, [
				item({
					type: 'function_call',
					call_id: 't1',
					name: 'exec',
					arguments: '{}',
				}),
				item({ type: 'function_call_output', call_id: 't1', output: 'ok' }),
				event('task_complete'),
			]);
			openTurns.delete(id);
			await settle();
		},
		async failTurn(id) {
			const e = entries.get(id);
			if (!e) return;
			if (!openTurns.has(id)) await append(e.path, [event('task_started')]);
			openTurns.delete(id);
			await append(e.path, [event('task_complete', { error: { message: 'failed' } })]);
			await settle();
		},
		async launchForegroundSubagent(id) {
			const parent = entries.get(id);
			const subagentId = randomUUID();
			const path = pathOf(subagentId);
			childOf.set(subagentId, id);
			await writeLines(path, [
				meta(subagentId, {
					parent_thread_id: id,
					thread_source: 'subagent',
					source: { subagent: { thread_spawn: { parent_thread_id: id } } },
					agent_nickname: 'Sartre',
				}),
				event('task_started'),
			]);
			if (parent) hold(parent.pid, path);
			await settle();
			return { subagentId };
		},
		async finishForegroundSubagent(_id, subagentId) {
			const path = pathOf(subagentId);
			await append(path, [event('task_complete')]);
			await settle();
		},
		async launchBackgroundSubagent(id) {
			const parent = entries.get(id);
			const subagentId = randomUUID();
			const path = pathOf(subagentId);
			childOf.set(subagentId, id);
			await writeLines(path, [
				meta(subagentId, {
					parent_thread_id: id,
					thread_source: 'subagent',
					source: { subagent: { thread_spawn: { parent_thread_id: id } } },
					agent_nickname: 'Hypatia',
				}),
				event('task_started'),
			]);
			if (parent) hold(parent.pid, path);
			await settle();
			return { subagentId };
		},
		async finishBackgroundSubagent(_id, subagentId) {
			await append(pathOf(subagentId), [event('task_complete')]);
			await settle();
		},
		async launchNestedSubagent(_id, parentSubagentId) {
			const subagentId = randomUUID();
			const path = pathOf(subagentId);
			const root = childOf.get(parentSubagentId) ?? _id;
			const parent = entries.get(root);
			childOf.set(subagentId, parentSubagentId);
			await writeLines(path, [
				meta(subagentId, {
					parent_thread_id: parentSubagentId,
					thread_source: 'subagent',
					source: { subagent: { thread_spawn: { parent_thread_id: parentSubagentId } } },
					agent_nickname: 'Euler',
				}),
				event('task_started'),
			]);
			if (parent) hold(parent.pid, path);
			await settle();
			return { subagentId };
		},
		async relocateJournal(id, newCwd) {
			const e = entries.get(id);
			if (!e) return;
			const dest = pathOf(id, randomUUID());
			await mkdir(dirname(dest), { recursive: true });
			await rename(e.path, dest);
			drop(e.pid, e.path);
			e.path = dest;
			e.cwd = newCwd;
			hold(e.pid, dest);
			await append(dest, [
				event('thread_settings_applied', { thread_settings: { cwd: newCwd, model: 'x' } }),
			]);
			await settle();
		},
	};
}
