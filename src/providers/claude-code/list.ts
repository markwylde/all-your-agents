import { join } from 'node:path';
import { decodeUtf8 } from '../../helpers/bytes.js';
import type { Fs } from '../../helpers/types.js';
import type { SessionKind, SessionSnapshot, TitleSource } from '../../types.js';
import { mapRecord, recordTime } from './journal.js';
import { projectsDir } from './paths.js';
import { mapKind } from './session-file.js';

const TAIL_BYTES = 64 * 1024;

export async function* listSessions(
	fs: Fs,
	home: string,
	opts: { since?: number; id?: string } = {},
): AsyncIterable<SessionSnapshot> {
	const root = projectsDir(home);
	let dirs: string[] = [];
	try {
		dirs = await fs.readDir(root);
	} catch {
		return;
	}
	for (const dir of dirs) {
		const dirPath = join(root, dir);
		let names: string[] = [];
		try {
			names = await fs.readDir(dirPath);
		} catch {
			continue;
		}
		for (const name of names) {
			if (!name.endsWith('.jsonl')) continue;
			if (name.startsWith('agent-')) continue;
			const id = name.slice(0, -'.jsonl'.length);
			if (opts.id && id !== opts.id) continue;
			const path = join(dirPath, name);
			const snap = await snapshotOf(fs, path, id, opts.since);
			if (snap) yield snap;
		}
	}
}

async function snapshotOf(
	fs: Fs,
	path: string,
	id: string,
	since?: number,
): Promise<SessionSnapshot | undefined> {
	const st = await fs.stat(path);
	if (!st?.isFile) return undefined;
	if (since != null && st.mtimeMs < since) return undefined;
	const head = decodeUtf8(await fs.readRange(path, 0, 32 * 1024));
	const tailStart = Math.max(0, st.size - TAIL_BYTES);
	const tail = tailStart === 0 ? head : decodeUtf8(await fs.readRange(path, tailStart, st.size));
	const titles: Partial<Record<TitleSource, string>> = {};
	let cwd: string | undefined;
	let startedAt: number | undefined;
	let updatedAt: number | undefined;
	let kind: SessionKind | undefined;
	let first = true;
	for (const line of head.split('\n')) {
		if (!line.trim()) continue;
		let rec: Record<string, unknown>;
		try {
			rec = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (rec.isSidechain === true) return undefined;
		if (typeof rec.cwd === 'string' && !cwd) cwd = rec.cwd;
		if (typeof rec.entrypoint === 'string' || typeof rec.kind === 'string') {
			kind = mapKind(rec.kind, rec.entrypoint) ?? kind;
		}
		const at = recordTime(rec);
		if (first) {
			startedAt = at;
			first = false;
		}
		for (const event of mapRecord(rec)) {
			if (event.kind === 'title') {
				if (event.source === 'user') titles.user = event.title;
				else if (event.source === 'harness') titles.harness = event.title;
				else if (event.source === 'prompt') titles.prompt = event.title;
			}
			if (event.kind === 'user' && !titles.prompt) titles.prompt = event.text.slice(0, 200);
		}
	}
	for (const line of tail.split('\n')) {
		if (!line.trim()) continue;
		try {
			const rec = JSON.parse(line) as Record<string, unknown>;
			const at = recordTime(rec);
			if (at != null) updatedAt = at;
			if (typeof rec.cwd === 'string') cwd = rec.cwd;
		} catch {}
	}
	if (updatedAt == null) updatedAt = st.mtimeMs;
	if (since != null && (updatedAt ?? startedAt ?? 0) < since) return undefined;
	const title = titles.user ?? titles.harness ?? titles.prompt;
	const snap: SessionSnapshot = {
		id,
		harness: 'ClaudeCode',
		provider: 'claude-code',
	};
	if (cwd) snap.cwd = cwd;
	if (title) snap.title = title;
	if (startedAt != null) snap.startedAt = startedAt;
	if (updatedAt != null) snap.updatedAt = updatedAt;
	if (kind) snap.kind = kind;
	return snap;
}
