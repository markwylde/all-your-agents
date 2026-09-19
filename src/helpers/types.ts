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
	/** The inode, where the filesystem has one: tells a replaced file from a rewritten one. */
	ino?: number;
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
	/**
	 * Present when this filesystem's watches can drop events while another watch is being
	 * opened or closed. Calls `listener` after each watch it opens or closes; returns
	 * unsubscribe. The watch helpers use it to re-verify once what they cover.
	 */
	onWatchChurn?(listener: () => void): () => void;
};

export type ProcessInfo = {
	alive: boolean;
	startTime?: number;
};

export type ProcessWatchHandle = {
	stop(): void;
};

export type ProcessWatchResult = ProcessWatchHandle | 'unsupported';

export type FileHolder = {
	path: string;
	pid: number;
};

export type Processes = {
	info(pid: number): Promise<ProcessInfo>;
	watch(pid: number, onExit: () => void): ProcessWatchResult;
	/**
	 * One-time: pids that currently have `path` open. Optional; a provider whose
	 * harness writes no pid index uses it to bind live sessions.
	 */
	holders?(path: string): Promise<number[]>;
	/**
	 * One-time: open files under `directory` and the pid holding each. Optional.
	 */
	heldUnder?(directory: string): Promise<FileHolder[]>;
	/**
	 * One-time: the process's controlling terminal as the device path below `/dev`
	 * (`ttys024`, `pts/3`), or nothing when it has none. Optional; a provider whose harness
	 * records the terminal a session runs in uses it to join a pid to that record.
	 */
	tty?(pid: number): Promise<string | undefined>;
};

export type SqliteValue = string | number | bigint | Uint8Array | null;

export type SqliteRow = Record<string, SqliteValue>;

/**
 * Read-only SQLite access. The only way a provider reads a database file. Each call opens
 * the file, runs one query, and closes it, so nothing is held between notifications.
 */
export type Sqlite = {
	query(path: string, sql: string, params?: SqliteValue[]): Promise<SqliteRow[]>;
};

export type DirChange = {
	type: 'create' | 'change' | 'delete';
	name: string;
	path: string;
};

export type WatchFileOptions = DebounceOptions & {
	/**
	 * Also watch the file itself. A directory watch on macOS reports nothing for writes made
	 * through a handle the writer keeps open (a SQLite WAL, for example).
	 */
	heldOpen?: boolean;
};

export type FileChange = {
	type: 'change' | 'delete';
	path: string;
};
