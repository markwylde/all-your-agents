import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Processes } from '../../../src/helpers/types.js';
import { encodeProjectDir } from '../../../src/providers/claude-code/paths.js';

/** Builders for a temporary Claude home: fake processes, session files and journals. */

export function fakeProcesses(start = Date.now() - 1000) {
	const alive = new Map<number, { alive: boolean; startTime: number }>();
	const exits = new Map<number, () => void>();
	const processes: Processes & {
		fire(pid: number): void;
		set(pid: number, a: boolean, t?: number): void;
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
		fire(pid) {
			exits.get(pid)?.();
		},
		set(pid, a, t = start) {
			if (a) alive.set(pid, { alive: true, startTime: t });
			else alive.delete(pid);
		},
	};
	return processes;
}

export async function sessionFile(
	home: string,
	pid: number,
	over: Record<string, unknown>,
	start: number,
): Promise<void> {
	await mkdir(join(home, 'sessions'), { recursive: true });
	await writeFile(
		join(home, 'sessions', `${pid}.json`),
		JSON.stringify({
			pid,
			startedAt: start,
			status: 'idle',
			cwd: '/tmp/app',
			...over,
		}),
	);
}

export async function journal(
	home: string,
	cwd: string,
	id: string,
	records: unknown[],
): Promise<void> {
	const dir = join(home, 'projects', encodeProjectDir(cwd));
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, `${id}.jsonl`),
		`${records.map((r) => JSON.stringify(r)).join('\n')}\n`,
	);
}
