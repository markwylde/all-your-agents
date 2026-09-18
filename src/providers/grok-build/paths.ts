import { homedir } from 'node:os';
import { join } from 'node:path';
import { encodeUtf8 } from '../../helpers/bytes.ts';

export type PathOptions = {
	home?: string;
	env?: Record<string, string | undefined>;
	homedir?: string;
};

/** Longest directory name Grok writes as the URL-encoded cwd; longer ones are hashed. */
export const MAX_DIR_NAME_BYTES = 255;

export function grokHome(opts: PathOptions = {}): string {
	if (opts.home) return opts.home;
	const env = opts.env ?? process.env;
	if (env.GROK_HOME) return env.GROK_HOME;
	return join(opts.homedir ?? homedir(), '.grok');
}

const UNRESERVED = /[A-Za-z0-9\-._~]/;

/**
 * Rust `urlencoding::encode`: every byte except RFC 3986 unreserved characters becomes
 * `%XX`. Unlike `encodeURIComponent`, `!'()*` are encoded too.
 */
export function encodeCwd(cwd: string): string {
	let out = '';
	for (const char of cwd) {
		if (UNRESERVED.test(char)) {
			out += char;
			continue;
		}
		for (const byte of encodeUtf8(char)) {
			out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
		}
	}
	return out;
}

export function indexPath(home: string): string {
	return join(home, 'active_sessions.json');
}

/** The log every Grok process shares. */
export function logPath(home: string): string {
	return join(home, 'logs', 'unified.jsonl');
}

export function sessionsDir(home: string): string {
	return join(home, 'sessions');
}

/**
 * Where Grok puts a session for this cwd, or undefined when the encoded cwd is too long
 * to be the directory name (Grok then uses a slug and a blake3 hash, found by lookup).
 */
export function derivedSessionDir(
	home: string,
	cwd: string,
	sessionId: string,
): string | undefined {
	const name = encodeCwd(cwd);
	if (encodeUtf8(name).byteLength > MAX_DIR_NAME_BYTES) return undefined;
	return join(sessionsDir(home), name, sessionId);
}
