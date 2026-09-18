import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Processes } from '../../../src/helpers/types.js';

export const A = '00000000-0000-4000-8000-00000000000a';
export const B = '00000000-0000-4000-8000-00000000000b';
export const C = '00000000-0000-4000-8000-00000000000c';

export function rolloutPath(
	home: string,
	id: string,
	stamp = '2026-01-01T00-00-00',
	extra = '',
): string {
	const name = extra ? `rollout-${stamp}-${id}_${extra}.jsonl` : `rollout-${stamp}-${id}.jsonl`;
	return join(home, 'sessions', stamp.slice(0, 4), stamp.slice(5, 7), stamp.slice(8, 10), name);
}

export function sessionMeta(
	id: string,
	over: Record<string, unknown> = {},
	at = new Date().toISOString(),
): Record<string, unknown> {
	return {
		timestamp: at,
		type: 'session_meta',
		payload: {
			id,
			session_id: id,
			cwd: '/tmp/app',
			timestamp: at,
			source: 'cli',
			originator: 'codex-tui',
			cli_version: '0.0.0',
			...over,
		},
	};
}

export function eventMsg(
	type: string,
	payload: Record<string, unknown> = {},
	at = new Date().toISOString(),
) {
	return { timestamp: at, type: 'event_msg', payload: { type, ...payload } };
}

export function responseItem(payload: Record<string, unknown>, at = new Date().toISOString()) {
	return { timestamp: at, type: 'response_item', payload };
}

export function collabSpawn(id: string, nick: string, at = new Date().toISOString()) {
	return eventMsg(
		'item_completed',
		{
			item: {
				type: 'CollabAgentToolCall',
				tool: 'spawn_agent',
				receiver_agents: [{ thread_id: id, agent_nickname: nick }],
				agents_states: { [id]: 'pending_init' },
			},
		},
		at,
	);
}

export function collabWait(
	id: string,
	status: unknown = { completed: 'done' },
	at = new Date().toISOString(),
) {
	return eventMsg(
		'item_completed',
		{
			item: {
				type: 'CollabAgentToolCall',
				tool: 'wait',
				agents_states: { [id]: status },
			},
		},
		at,
	);
}

export async function writeRollout(path: string, records: unknown[]): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, records.map((r) => `${JSON.stringify(r)}\n`).join(''));
}

export function fakeCodexProcesses(start = Date.now() - 1000) {
	const alive = new Map<number, { alive: boolean; startTime: number }>();
	const exits = new Map<number, () => void>();
	const open = new Map<string, Set<number>>();
	const processes: Processes & {
		fire(pid: number): void;
		set(pid: number, a: boolean, t?: number): void;
		hold(pid: number, path: string): void;
		drop(pid: number, path: string): void;
	} = {
		async info(pid) {
			return alive.get(pid) ?? { alive: false };
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
		fire(pid) {
			exits.get(pid)?.();
		},
		set(pid, a, t = start) {
			if (a) alive.set(pid, { alive: true, startTime: t });
			else alive.delete(pid);
		},
		hold(pid, path) {
			const set = open.get(path) ?? new Set();
			set.add(pid);
			open.set(path, set);
		},
		drop(pid, path) {
			open.get(path)?.delete(pid);
		},
	};
	return processes;
}
