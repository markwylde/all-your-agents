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

export function createLocalProcesses(opts: ProcessesOptions = {}): Processes & { close(): void } {
	const enabled = opts.koffi ?? koffiAvailable();
	const watchers = new Map<number, WatchState>();
	let worker: Worker | undefined;

	if (enabled) {
		try {
			worker = new Worker(new URL('./process-watch-worker.js', import.meta.url));
			worker.unref();
			worker.on('message', (msg: { type: string; pid?: number }) => {
				if (msg.type !== 'exit' || msg.pid == null) return;
				const state = watchers.get(msg.pid);
				if (!state) return;
				watchers.delete(msg.pid);
				if (watchers.size === 0) worker?.unref();
				for (const cb of state.callbacks) cb();
			});
			worker.on('error', () => {
				try {
					worker?.unref();
					void worker?.terminate();
				} catch {
					// ignore
				}
				worker = undefined;
			});
		} catch {
			worker = undefined;
		}
	}

	return {
		async info(pid) {
			if (platform() === 'darwin') return macInfo(pid);
			if (platform() === 'linux') return linuxInfo(pid);
			return { alive: false };
		},
		watch(pid, onExit): ProcessWatchResult {
			if (!enabled || !worker) return 'unsupported';
			let state = watchers.get(pid);
			if (!state) {
				state = { callbacks: new Set() };
				watchers.set(pid, state);
				worker.ref();
				worker.postMessage({ type: 'watch', pid });
			}
			state.callbacks.add(onExit);
			return {
				stop() {
					const current = watchers.get(pid);
					if (!current) return;
					current.callbacks.delete(onExit);
					if (current.callbacks.size === 0) {
						watchers.delete(pid);
						if (watchers.size === 0) worker?.unref();
						worker?.postMessage({ type: 'unwatch', pid });
					}
				},
			};
		},
		close() {
			const current = worker;
			worker = undefined;
			watchers.clear();
			if (!current) return;
			try {
				current.postMessage({ type: 'stop' });
			} catch {
				// already dead
			}
			current.unref();
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
