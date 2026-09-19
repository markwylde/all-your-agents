import { isAbsolute, resolve } from 'node:path';
import { decodeUtf8 } from '../../helpers/bytes.ts';
import type { Fs } from '../../helpers/types.ts';
import { parseSessionPath } from './paths.ts';
import { readHead } from './session-file.ts';

export const REGISTRY_MAX_BYTES = 16 * 1024;

/** `run/daemons/<hash>/clients/<pid>-<uuid>.json`: written at launch, removed on a clean exit. */
export type Presence = { pid: number; projectDir?: string };

/** `agent/terminal-sessions/<terminal>`: the session a terminal is on right now. */
export type Breadcrumb = {
	cwd: string;
	/** Absolute: omp may record one relative to `cwd` (`--session notes/work`). */
	sessionPath: string;
	/** From the file name; a custom-named file only says so in its header. */
	sessionId?: string;
	startedAt?: number;
	/** The session file has not been written yet. */
	fresh: boolean;
};

export function parsePresence(text: string): Presence | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!raw || typeof raw !== 'object') return undefined;
	const row = raw as Record<string, unknown>;
	const pid = row.pid;
	if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
	const presence: Presence = { pid };
	if (typeof row.projectDir === 'string' && row.projectDir) presence.projectDir = row.projectDir;
	return presence;
}

/** Line 1 cwd, line 2 session file, then `fresh` and `cwdstat <dev> <ino>` in any order. */
export function parseBreadcrumb(text: string): Breadcrumb | undefined {
	const lines = text.split('\n').map((line) => line.trim());
	const cwd = lines[0];
	const recorded = lines[1];
	if (!cwd || !recorded || !isAbsolute(cwd)) return undefined;
	const sessionPath = resolve(cwd, recorded);
	const crumb: Breadcrumb = { cwd, sessionPath, fresh: lines.slice(2).includes('fresh') };
	const name = parseSessionPath(sessionPath);
	if (name) crumb.sessionId = name.id;
	if (name?.startedAt != null) crumb.startedAt = name.startedAt;
	return crumb;
}

/**
 * omp names a breadcrumb after stdin's terminal device. Only when stdin is not a terminal
 * does it fall back to a multiplexer or emulator id (`tmux-%3`, `kitty-7`, `apple-…`), and
 * a process like that has no terminal for us to join on.
 */
export function isTerminalName(name: string): boolean {
	return /^(ttys?\d+|tty[A-Za-z]*\d+|pts-\d+)$/.test(name);
}

/** `/dev/pts/3` is recorded as `pts-3`. */
export function breadcrumbNameOf(tty: string): string {
	return tty.replace(/\//g, '-');
}

async function readBounded(fs: Fs, path: string): Promise<string | undefined> {
	try {
		const st = await fs.stat(path);
		if (!st?.isFile || st.size > REGISTRY_MAX_BYTES) return undefined;
		return decodeUtf8(await fs.readFile(path, { maxBytes: REGISTRY_MAX_BYTES }));
	} catch {
		return undefined;
	}
}

export async function readPresence(fs: Fs, path: string): Promise<Presence | undefined> {
	const text = await readBounded(fs, path);
	return text == null ? undefined : parsePresence(text);
}

export type KnownBreadcrumb = Breadcrumb & { sessionId: string; mtimeMs: number };

/**
 * A breadcrumb with the session it names identified. A custom-named session is known by its
 * header, so one not yet written names nothing yet; omp rewrites the breadcrumb once it is.
 */
export async function readBreadcrumb(fs: Fs, path: string): Promise<KnownBreadcrumb | undefined> {
	const st = await fs.stat(path).catch(() => null);
	if (!st?.isFile) return undefined;
	const text = await readBounded(fs, path);
	const crumb = text == null ? undefined : parseBreadcrumb(text);
	if (!crumb) return undefined;
	const sessionId = crumb.sessionId ?? (await readHead(fs, crumb.sessionPath))?.id;
	return sessionId ? { ...crumb, sessionId, mtimeMs: st.mtimeMs } : undefined;
}
