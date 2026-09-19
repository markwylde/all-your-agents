import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { Fs } from '../../helpers/types.ts';

export type PathOptions = {
	home?: string;
	env?: Record<string, string | undefined>;
	homedir?: string;
};

/** Where one omp installation, or one of its named profiles, keeps what we read. */
export type Root = {
	/** `agent/sessions`: one directory per encoded cwd, holding the transcripts. */
	sessions: string;
	/** `agent/terminal-sessions`: one breadcrumb per terminal. */
	terminalSessions: string;
	/** `run/daemons`: one directory per project, each with a `clients/` of presence files. */
	daemons: string;
	/** `agent/history.db`: every submitted prompt, with its session id. */
	historyDb: string;
	/** `agent/custom-session-files`: one file per session kept outside `sessions`, holding its path. */
	customSessionFiles: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_FILE = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)_([0-9a-f-]{36})\.jsonl$/i;
const PROFILE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const APP = 'omp';

export function ompHome(opts: PathOptions = {}): string {
	if (opts.home) return opts.home;
	const env = opts.env ?? process.env;
	return join(opts.homedir ?? homedir(), env.PI_CONFIG_DIR || '.omp');
}

export function profilesDir(home: string): string {
	return join(home, 'profiles');
}

export function isProfileName(name: string): boolean {
	return PROFILE_NAME.test(name) && !name.endsWith('.');
}

function plainRoot(configRoot: string, agentDir: string): Root {
	return {
		sessions: join(agentDir, 'sessions'),
		terminalSessions: join(agentDir, 'terminal-sessions'),
		daemons: join(configRoot, 'run', 'daemons'),
		historyDb: join(agentDir, 'history.db'),
		customSessionFiles: join(agentDir, 'custom-session-files'),
	};
}

/**
 * The directories omp itself resolves (`utils/src/dirs.ts`). An explicit `home` is taken
 * as is. Otherwise `PI_CODING_AGENT_DIR` moves the default profile's agent directory (and
 * then XDG is ignored), and `$XDG_DATA_HOME/omp` / `$XDG_STATE_HOME/omp` redirect, with the `agent/` level
 * flattened away, once they exist: omp trusts their existence as "migrated".
 */
export async function resolveRoot(fs: Fs, opts: PathOptions = {}, profile?: string): Promise<Root> {
	const home = ompHome(opts);
	const configRoot = profile ? join(profilesDir(home), profile) : home;
	if (opts.home) return plainRoot(configRoot, join(configRoot, 'agent'));
	const env = opts.env ?? process.env;
	const defaultAgentDir = join(configRoot, 'agent');
	const override = profile ? undefined : env.PI_CODING_AGENT_DIR;
	const agentDir = override ? resolve(override) : defaultAgentDir;
	const root = plainRoot(configRoot, agentDir);
	// omp honours XDG only for its default agent directory: a moved one takes everything.
	if (agentDir !== defaultAgentDir) return root;
	const redirected = async (name: string): Promise<string | undefined> => {
		const value = env[name];
		if (!value) return undefined;
		const target = profile ? join(value, APP, 'profiles', profile) : join(value, APP);
		const st = await fs.stat(target).catch(() => null);
		return st?.isDirectory ? target : undefined;
	};
	const data = await redirected('XDG_DATA_HOME');
	if (data) {
		root.sessions = join(data, 'sessions');
		root.historyDb = join(data, 'history.db');
	}
	const state = await redirected('XDG_STATE_HOME');
	if (state) {
		root.terminalSessions = join(state, 'terminal-sessions');
		root.customSessionFiles = join(state, 'custom-session-files');
		root.daemons = join(state, 'run', 'daemons');
	}
	return root;
}

/**
 * Where named profiles are: `<home>/profiles`, and `$XDG_DATA_HOME/omp/profiles` /
 * `$XDG_STATE_HOME/omp/profiles`, where a migrated profile may be all there is of it.
 */
export function profileDirs(opts: PathOptions = {}): string[] {
	const dirs = [profilesDir(ompHome(opts))];
	if (opts.home) return dirs;
	const env = opts.env ?? process.env;
	for (const name of ['XDG_DATA_HOME', 'XDG_STATE_HOME']) {
		const value = env[name];
		if (value) dirs.push(join(value, APP, 'profiles'));
	}
	return dirs;
}

/** Every named profile present in any of `profileDirs`. */
export async function profileNames(fs: Fs, opts: PathOptions = {}): Promise<string[]> {
	const names = new Set<string>();
	for (const dir of profileDirs(opts)) {
		for (const name of await fs.readDir(dir).catch(() => [] as string[])) {
			if (isProfileName(name)) names.add(name);
		}
	}
	return [...names].sort();
}

/** The default root, then one per named profile. */
export async function resolveRoots(fs: Fs, opts: PathOptions = {}): Promise<Root[]> {
	const roots = [await resolveRoot(fs, opts)];
	for (const name of await profileNames(fs, opts)) roots.push(await resolveRoot(fs, opts, name));
	return roots;
}

export function historyWalPath(root: Root): string {
	return `${root.historyDb}-wal`;
}

export function clientsDir(root: Root, hash: string): string {
	return join(root.daemons, hash, 'clients');
}

export type SessionFileName = { id: string; startedAt?: number };

/** `<ISO timestamp with dashes>_<uuid>.jsonl`; the uuid is the session id. */
export function parseSessionFileName(name: string): SessionFileName | undefined {
	const m = SESSION_FILE.exec(name);
	if (!m?.[1] || !m[2] || !UUID.test(m[2])) return undefined;
	const iso = m[1].replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z');
	const at = Date.parse(iso);
	return { id: m[2].toLowerCase(), startedAt: Number.isFinite(at) ? at : undefined };
}

export function parseSessionPath(path: string): SessionFileName | undefined {
	return parseSessionFileName(basename(path));
}

/**
 * Subagent transcripts and tool logs live beside the transcript, in a directory named after
 * it. omp gives a session file not named `*.jsonl` (`--session notes/work`) none.
 */
export function artifactDir(sessionPath: string): string | undefined {
	if (!sessionPath.endsWith('.jsonl')) return undefined;
	return join(dirname(sessionPath), basename(sessionPath).slice(0, -'.jsonl'.length));
}

export function isUuid(value: unknown): value is string {
	return typeof value === 'string' && UUID.test(value);
}
