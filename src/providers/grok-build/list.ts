import { join } from 'node:path';
import { decodeUtf8 } from '../../helpers/bytes.ts';
import type { Fs } from '../../helpers/types.ts';
import type { SessionKind, SessionSnapshot, TitleSource } from '../../types.ts';
import { cwdOfDir, mapChatRecord, promptTitle } from './journal.ts';
import { sessionsDir } from './paths.ts';

export const SUMMARY_MAX_BYTES = 256 * 1024;
const CHAT_HEAD_BYTES = 64 * 1024;

export type Summary = {
	cwd?: string;
	title?: { title: string; source: Extract<TitleSource, 'user' | 'harness'> };
	startedAt?: number;
	updatedAt?: number;
	model?: string;
	sessionKind?: string;
	kind: SessionKind;
};

const time = (value: unknown): number | undefined => {
	if (typeof value !== 'string') return undefined;
	const n = Date.parse(value);
	return Number.isFinite(n) ? n : undefined;
};

export function parseSummary(bytes: Uint8Array): Summary | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(decodeUtf8(bytes));
	} catch {
		return undefined;
	}
	if (!raw || typeof raw !== 'object') return undefined;
	const row = raw as Record<string, unknown>;
	const out: Summary = { kind: row.session_kind === 'headless' ? 'headless' : 'interactive' };
	const info =
		row.info && typeof row.info === 'object' ? (row.info as Record<string, unknown>) : {};
	if (typeof info.cwd === 'string' && info.cwd) out.cwd = info.cwd;
	if (typeof row.generated_title === 'string' && row.generated_title) {
		out.title = {
			title: row.generated_title,
			source: row.title_is_manual === true ? 'user' : 'harness',
		};
	}
	const startedAt = time(row.created_at);
	if (startedAt != null) out.startedAt = startedAt;
	const updatedAt = time(row.last_active_at) ?? time(row.updated_at);
	if (updatedAt != null) out.updatedAt = updatedAt;
	if (typeof row.current_model_id === 'string' && row.current_model_id) {
		out.model = row.current_model_id;
	}
	if (typeof row.session_kind === 'string') out.sessionKind = row.session_kind;
	return out;
}

/** Subagent sessions have their own directories, but they are not sessions of their own. */
export function isSubagentKind(kind: string | undefined): boolean {
	return kind === 'subagent' || kind === 'subagent_fork';
}

export async function readSummary(fs: Fs, sessionDir: string): Promise<Summary | undefined> {
	try {
		return parseSummary(
			await fs.readFile(join(sessionDir, 'summary.json'), { maxBytes: SUMMARY_MAX_BYTES }),
		);
	} catch {
		return undefined;
	}
}

/** The first real prompt, from the start of the conversation only. */
export async function firstPrompt(fs: Fs, sessionDir: string): Promise<string | undefined> {
	let bytes: Uint8Array;
	try {
		bytes = await fs.readRange(join(sessionDir, 'chat_history.jsonl'), 0, CHAT_HEAD_BYTES);
	} catch {
		return undefined;
	}
	const lines = decodeUtf8(bytes).split('\n');
	// The last line may be cut off by the bound.
	if (bytes.byteLength === CHAT_HEAD_BYTES) lines.pop();
	const state = {};
	for (const line of lines) {
		if (!line.trim()) continue;
		let rec: unknown;
		try {
			rec = JSON.parse(line);
		} catch {
			continue;
		}
		for (const event of mapChatRecord(rec, state)) {
			if (event.kind === 'user') return promptTitle(event.text);
		}
	}
	return undefined;
}

export async function* listSessions(
	fs: Fs,
	home: string,
	opts: { since?: number; id?: string } = {},
): AsyncIterable<SessionSnapshot> {
	const root = sessionsDir(home);
	let cwdDirs: string[];
	try {
		cwdDirs = await fs.readDir(root);
	} catch {
		return;
	}
	for (const cwdName of cwdDirs) {
		const cwdDir = join(root, cwdName);
		let names: string[];
		if (opts.id) {
			names = [opts.id];
		} else {
			try {
				names = await fs.readDir(cwdDir);
			} catch {
				continue;
			}
		}
		for (const name of names) {
			const snap = await snapshotOf(fs, cwdDir, cwdName, name, opts.since);
			if (snap) yield snap;
		}
	}
}

async function snapshotOf(
	fs: Fs,
	cwdDir: string,
	cwdName: string,
	id: string,
	since?: number,
): Promise<SessionSnapshot | undefined> {
	const dir = join(cwdDir, id);
	const st = await fs.stat(join(dir, 'summary.json')).catch(() => null);
	if (!st?.isFile) return undefined;
	if (since != null && st.mtimeMs < since) return undefined;
	const summary = await readSummary(fs, dir);
	if (!summary || isSubagentKind(summary.sessionKind)) return undefined;
	const updatedAt = summary.updatedAt ?? st.mtimeMs;
	if (since != null && updatedAt < since) return undefined;
	const snap: SessionSnapshot = { id, harness: 'Grok', provider: 'grok-build', kind: summary.kind };
	const cwd = summary.cwd ?? (await cwdOfDir(fs, cwdDir, cwdName));
	if (cwd) snap.cwd = cwd;
	const title = summary.title?.title ?? (await firstPrompt(fs, dir));
	if (title) snap.title = title;
	if (summary.startedAt != null) snap.startedAt = summary.startedAt;
	snap.updatedAt = updatedAt;
	if (summary.model) snap.model = summary.model;
	return snap;
}
