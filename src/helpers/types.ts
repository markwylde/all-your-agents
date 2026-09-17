export type Clock = {
	now(): number;
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(id: unknown): void;
};

export type DebounceOptions = {
	quietMs?: number;
	maxLatencyMs?: number;
	clock?: Clock;
};

export type FsStat = {
	size: number;
	mtimeMs: number;
	isFile: boolean;
	isDirectory: boolean;
};

export type FsWatchEvent = {
	type: 'rename' | 'change';
	filename: string | null;
};

export type WatchHandle = AsyncIterable<FsWatchEvent> & {
	close(): void;
};

export type Fs = {
	readFile(path: string, opts?: { maxBytes?: number }): Promise<Uint8Array>;
	readRange(path: string, start: number, end?: number): Promise<Uint8Array>;
	readDir(path: string): Promise<string[]>;
	stat(path: string): Promise<FsStat | null>;
	watch(path: string): WatchHandle;
};

export type ProcessInfo = {
	alive: boolean;
	startTime?: number;
};

export type ProcessWatchHandle = {
	stop(): void;
};

export type ProcessWatchResult = ProcessWatchHandle | 'unsupported';

export type Processes = {
	info(pid: number): Promise<ProcessInfo>;
	watch(pid: number, onExit: () => void): ProcessWatchResult;
};

export type DirChange = {
	type: 'create' | 'change' | 'delete';
	name: string;
	path: string;
};

export type FileChange = {
	type: 'change' | 'delete';
	path: string;
};
