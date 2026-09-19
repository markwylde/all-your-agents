import { homedir } from 'node:os';
import { join } from 'node:path';

export type PathOptions = {
	home?: string;
	env?: Record<string, string | undefined>;
	homedir?: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/;

export function codexHome(opts: PathOptions = {}): string {
	if (opts.home) return opts.home;
	const env = opts.env ?? process.env;
	if (env.CODEX_HOME) return env.CODEX_HOME;
	return join(opts.homedir ?? homedir(), '.codex');
}

export function sessionsDir(home: string): string {
	return join(home, 'sessions');
}

export function threadLocksDir(home: string): string {
	return join(home, 'thread-writer-locks');
}

export function threadLockPath(home: string, threadId: string): string {
	return join(threadLocksDir(home), `${threadId}.lock`);
}

/** Thread id from a `thread-writer-locks` entry, or undefined for anything else. */
export function parseLockName(name: string): string | undefined {
	if (!name.endsWith('.lock')) return undefined;
	const id = name.slice(0, -'.lock'.length);
	return UUID.test(id) ? id : undefined;
}

export function sessionIndexPath(home: string): string {
	return join(home, 'session_index.jsonl');
}

export type RolloutName = {
	timestamp: string;
	threadId: string;
	rolloutId: string;
	compressed: boolean;
};

/** Codex `RolloutFileName`: thread id is the UUID after the timestamp, not after `_`. */
export function parseRolloutName(name: string): RolloutName | undefined {
	let file = name;
	let compressed = false;
	if (file.endsWith('.zst')) {
		file = file.slice(0, -4);
		compressed = true;
	}
	if (!file.startsWith('rollout-') || !file.endsWith('.jsonl')) return undefined;
	const core = file.slice('rollout-'.length, -'.jsonl'.length);
	const stamp = core.slice(0, 19);
	if (!STAMP.test(stamp) || core[19] !== '-') return undefined;
	const ids = core.slice(20);
	const cut = ids.indexOf('_');
	const threadId = cut === -1 ? ids : ids.slice(0, cut);
	const rolloutId = cut === -1 ? ids : ids.slice(cut + 1);
	if (!UUID.test(threadId) || !UUID.test(rolloutId)) return undefined;
	return { timestamp: stamp, threadId, rolloutId, compressed };
}

export function isRolloutName(name: string): boolean {
	return parseRolloutName(name) != null;
}

export function filenameTimestampMs(stamp: string): number | undefined {
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})$/.exec(stamp);
	if (!match) return undefined;
	const ms = Date.UTC(
		Number(match[1]),
		Number(match[2]) - 1,
		Number(match[3]),
		Number(match[4]),
		Number(match[5]),
		Number(match[6]),
	);
	return Number.isFinite(ms) ? ms : undefined;
}
