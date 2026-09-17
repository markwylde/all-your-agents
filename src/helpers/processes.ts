import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { platform } from 'node:os';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';
import type { Processes, ProcessInfo, ProcessWatchResult } from './types.js';

const execFileAsync = promisify(execFile);

export type ProcessesOptions = {
	koffi?: boolean;
};

type WatchState = {
	callbacks: Set<() => void>;
};

export function koffiAvailable(): boolean {
	try {
		createRequire(import.meta.url).resolve('koffi');
		return true;
	} catch {
		return false;
	}
}

type WorkerHandle = {
	worker: Worker;
	exited: Promise<void>;
};

/**
 * The process-watch worker exists only while at least one pid is watched, and it
 * is never unref'd. koffi aborts the whole process if Node tears a worker down
 * while it is loading or has a native call in flight, so the worker must always
 * stop itself: we post `stop`, it wakes its wait via its pipe, closes its port,
 * and exits. `close()` resolves only once that exit has happened.
 */
export function createLocalProcesses(
	opts: ProcessesOptions = {},
): Processes & { close(): Promise<void> } {
	let enabled = opts.koffi ?? koffiAvailable();
	const watchers = new Map<number, WatchState>();
	const stopping = new Set<Promise<void>>();
	let current: WorkerHandle | undefined;

	const spawn = (): WorkerHandle | undefined => {
		let worker: Worker;
		try {
			worker = new Worker(new URL('./process-watch-worker.js', import.meta.url));
		} catch {
			return undefined;
		}
		const handle: WorkerHandle = {
			worker,
			exited: new Promise<void>((resolve) => {
				worker.once('exit', () => resolve());
			}),
		};
		worker.on('message', (msg: { type: string; pid?: number }) => {
			if (msg.type === 'unsupported') {
				enabled = false;
				return;
			}
			if (msg.type !== 'exit' || msg.pid == null || current !== handle) return;
			const state = watchers.get(msg.pid);
			if (!state) return;
			watchers.delete(msg.pid);
			for (const cb of state.callbacks) cb();
			if (watchers.size === 0 && current === handle) retire();
		});
		worker.on('error', () => {
			if (current === handle) current = undefined;
		});
		void handle.exited.then(() => {
			if (current === handle) current = undefined;
		});
		return handle;
	};

	const retire = (): void => {
		const handle = current;
		current = undefined;
		if (!handle) return;
		try {
			handle.worker.postMessage({ type: 'stop' });
		} catch {
			// already exited
		}
		stopping.add(handle.exited);
		void handle.exited.then(() => stopping.delete(handle.exited));
	};

	return {
		async info(pid) {
			if (platform() === 'darwin') return macInfo(pid);
			if (platform() === 'linux') return linuxInfo(pid);
			return { alive: false };
		},
		watch(pid, onExit): ProcessWatchResult {
			if (!enabled) return 'unsupported';
			current ??= spawn();
			const handle = current;
			if (!handle) return 'unsupported';
			let state = watchers.get(pid);
			if (!state) {
				state = { callbacks: new Set() };
				watchers.set(pid, state);
				handle.worker.postMessage({ type: 'watch', pid });
			}
			state.callbacks.add(onExit);
			return {
				stop() {
					const entry = watchers.get(pid);
					if (!entry) return;
					entry.callbacks.delete(onExit);
					if (entry.callbacks.size > 0) return;
					watchers.delete(pid);
					if (current !== handle) return;
					if (watchers.size === 0) retire();
					else handle.worker.postMessage({ type: 'unwatch', pid });
				},
			};
		},
		async close() {
			watchers.clear();
			retire();
			await Promise.all([...stopping]);
		},
	};
}

const MONTHS: Record<string, number> = {
	Jan: 0,
	Feb: 1,
	Mar: 2,
	Apr: 3,
	May: 4,
	Jun: 5,
	Jul: 6,
	Aug: 7,
	Sep: 8,
	Oct: 9,
	Nov: 10,
	Dec: 11,
};

async function macInfo(pid: number): Promise<ProcessInfo> {
	try {
		const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], {
			env: { ...process.env, LC_ALL: 'C' },
		});
		const line = stdout.trim();
		if (!line) return { alive: false };
		return { alive: true, startTime: parseLstart(line) };
	} catch {
		return { alive: false };
	}
}

export function parseLstart(line: string): number | undefined {
	const match = /^(\w+)\s+(\w+)\s+(\d+)\s+(\d+):(\d+):(\d+)\s+(\d+)$/.exec(line.trim());
	if (!match) return undefined;
	const month = MONTHS[match[2] ?? ''];
	if (month == null) return undefined;
	return new Date(
		Number(match[7]),
		month,
		Number(match[3]),
		Number(match[4]),
		Number(match[5]),
		Number(match[6]),
	).getTime();
}

async function linuxInfo(pid: number): Promise<ProcessInfo> {
	try {
		const [statText, procStat] = await Promise.all([
			readFile(`/proc/${pid}/stat`, 'utf8'),
			readFile('/proc/stat', 'utf8'),
		]);
		const closeParen = statText.lastIndexOf(')');
		const rest = statText.slice(closeParen + 2).split(' ');
		const startTicks = Number(rest[19]);
		const btimeLine = procStat.split('\n').find((line) => line.startsWith('btime '));
		const btime = Number(btimeLine?.slice(6));
		const hz = 100;
		if (!Number.isFinite(startTicks) || !Number.isFinite(btime)) return { alive: true };
		return { alive: true, startTime: (btime + startTicks / hz) * 1000 };
	} catch {
		return { alive: false };
	}
}
