import { execFile } from 'node:child_process';
import { readdir, readFile, readlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { platform } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';
import type { FileHolder, Processes, ProcessInfo, ProcessWatchResult } from './types.ts';

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
			// Run from source (`node file.ts`) the worker is a .ts file; built, it is .js.
			const ext = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
			worker = new Worker(new URL(`./process-watch-worker.${ext}`, import.meta.url));
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
		// Our own watches and reads hold these files too (kqueue watches are fds), and
		// this process is never a harness, so it is never reported as a holder.
		async holders(path) {
			let pids: number[] = [];
			if (platform() === 'darwin') pids = await macHolders(path);
			else if (platform() === 'linux') pids = await linuxHolders(path);
			return pids.filter((pid) => pid !== process.pid);
		},
		async heldUnder(directory) {
			let held: FileHolder[] = [];
			if (platform() === 'darwin') held = await macHeldUnder(directory);
			else if (platform() === 'linux') held = await linuxHeldUnder(directory);
			return held.filter((row) => row.pid !== process.pid);
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

const LSOF_OPTS = { maxBuffer: 32 * 1024 * 1024, timeout: 15_000 };

function parseLsofPids(stdout: string): number[] {
	const pids = new Set<number>();
	for (const line of stdout.split('\n')) {
		if (line.startsWith('p')) {
			const pid = Number(line.slice(1));
			if (Number.isInteger(pid) && pid > 0) pids.add(pid);
		}
	}
	return [...pids];
}

function stripPrivate(path: string): string {
	return path.startsWith('/private/') ? path.slice('/private'.length) : path;
}

function parseLsofHolders(stdout: string, prefix: string): FileHolder[] {
	const out: FileHolder[] = [];
	let pid = 0;
	const root = stripPrivate(prefix);
	const rootSlash = root.endsWith('/') ? root : `${root}/`;
	for (const line of stdout.split('\n')) {
		if (line.startsWith('p')) {
			pid = Number(line.slice(1));
			continue;
		}
		if (!line.startsWith('n') || !Number.isInteger(pid) || pid <= 0) continue;
		const path = line.slice(1);
		const normalized = stripPrivate(path);
		if (normalized !== root && !normalized.startsWith(rootSlash)) continue;
		if (!normalized.endsWith('.jsonl')) continue;
		out.push({ path: normalized, pid });
	}
	return out;
}

async function macHolders(path: string): Promise<number[]> {
	try {
		const { stdout } = await execFileAsync('lsof', ['-nP', '-F', 'p', '--', path], LSOF_OPTS);
		return parseLsofPids(stdout);
	} catch (error) {
		const code = (error as { status?: number }).status;
		if (code === 1) return [];
		return [];
	}
}

async function macHeldUnder(directory: string): Promise<FileHolder[]> {
	try {
		const { stdout } = await execFileAsync('lsof', ['-nP', '-F', 'pn'], LSOF_OPTS);
		return parseLsofHolders(stdout, directory);
	} catch (error) {
		const code = (error as { status?: number }).status;
		if (code === 1) return [];
		return [];
	}
}

async function linuxFdTargets(pid: string): Promise<string[]> {
	const dir = join('/proc', pid, 'fd');
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	const out: string[] = [];
	for (const name of names) {
		try {
			out.push(await readlink(join(dir, name)));
		} catch {
			// gone
		}
	}
	return out;
}

async function linuxPids(): Promise<string[]> {
	try {
		return (await readdir('/proc')).filter((name) => /^\d+$/.test(name));
	} catch {
		return [];
	}
}

async function linuxHolders(path: string): Promise<number[]> {
	const pids: number[] = [];
	for (const pid of await linuxPids()) {
		const targets = await linuxFdTargets(pid);
		if (targets.includes(path)) pids.push(Number(pid));
	}
	return pids;
}

async function linuxHeldUnder(directory: string): Promise<FileHolder[]> {
	const prefix = directory.endsWith('/') ? directory : `${directory}/`;
	const out: FileHolder[] = [];
	for (const pid of await linuxPids()) {
		for (const target of await linuxFdTargets(pid)) {
			if ((target === directory || target.startsWith(prefix)) && target.endsWith('.jsonl')) {
				out.push({ path: target, pid: Number(pid) });
			}
		}
	}
	return out;
}
