import { isAbsolute, join } from 'node:path';
import { decodeUtf8 } from '../../helpers/bytes.ts';
import type { Fs } from '../../helpers/types.ts';
import type { SessionSnapshot } from '../../types.ts';
import { entryOf, modelOf, userTextOf } from './events.ts';
import { promptTitle, readRecords } from './journal.ts';
import { parseSessionFileName, type Root } from './paths.ts';
import { HEAD_MAX_BYTES, parseHead, readHead } from './session-file.ts';

const HARNESS = 'OhMyPi';
const PROVIDER = 'oh-my-pi';
const TAIL_MAX_BYTES = 256 * 1024;
const REGISTRY_ENTRY_MAX_BYTES = 4096;

/** `id` comes from the file name; a custom-named file is known only by its header. */
export type SessionFile = { id?: string; path: string };

/**
 * Sessions kept outside `sessions` (`--session notes/work`, `--session-dir`): omp records
 * each one's absolute path in a file of its own. Their headers are read only when listed.
 */
async function customSessionFiles(fs: Fs, root: Root): Promise<SessionFile[]> {
	const out: SessionFile[] = [];
	let names: string[] = [];
	try {
		names = await fs.readDir(root.customSessionFiles);
	} catch {
		return out;
	}
	for (const name of names) {
		let path: string;
		try {
			const bytes = await fs.readFile(join(root.customSessionFiles, name), {
				maxBytes: REGISTRY_ENTRY_MAX_BYTES,
			});
			path = decodeUtf8(bytes).trim();
		} catch {
			continue;
		}
		if (isAbsolute(path)) out.push({ path });
	}
	return out;
}

/** Transcripts directly under each encoded-cwd directory, then those kept elsewhere. */
export async function listSessionFiles(fs: Fs, root: Root): Promise<SessionFile[]> {
	const out: SessionFile[] = [];
	let dirs: string[] = [];
	try {
		dirs = await fs.readDir(root.sessions);
	} catch {
		return customSessionFiles(fs, root);
	}
	for (const dir of dirs) {
		let names: string[] = [];
		try {
			names = await fs.readDir(join(root.sessions, dir));
		} catch {
			continue;
		}
		for (const name of names) {
			const parsed = parseSessionFileName(name);
			if (parsed) out.push({ id: parsed.id, path: join(root.sessions, dir, name) });
		}
	}
	out.push(...(await customSessionFiles(fs, root)));
	return out;
}

export async function findSessionFile(
	fs: Fs,
	roots: Root[],
	id: string,
): Promise<string | undefined> {
	for (const root of roots) {
		for (const file of await listSessionFiles(fs, root)) {
			const fileId = file.id ?? (await readHead(fs, file.path, { requireNameMatch: true }))?.id;
			if (fileId === id) return file.path;
		}
	}
	return undefined;
}

function completeLines(text: string, fromStart: boolean): string[] {
	const lines = text.split('\n');
	// A bounded read cuts a line at one end: drop the piece.
	if (fromStart) lines.pop();
	else lines.shift();
	return lines;
}

function parse(line: string): unknown {
	try {
		return JSON.parse(line);
	} catch {
		return undefined;
	}
}

/** The model of the last assistant message that fits in the tail, without reading the rest. */
async function tailModel(fs: Fs, path: string, size: number): Promise<string | undefined> {
	const start = Math.max(0, size - TAIL_MAX_BYTES);
	const text = decodeUtf8(await fs.readRange(path, start, size));
	const lines = start === 0 ? text.split('\n') : completeLines(text, false);
	for (let i = lines.length - 1; i >= 0; i--) {
		const entry = entryOf(parse(lines[i] ?? ''));
		if (entry?.message?.role !== 'assistant') continue;
		const model = modelOf(entry.message);
		if (model) return model;
	}
	return undefined;
}

export async function snapshotOf(
	fs: Fs,
	file: SessionFile,
	since?: number,
): Promise<SessionSnapshot | undefined> {
	const st = await fs.stat(file.path).catch(() => null);
	if (!st?.isFile) return undefined;
	if (since != null && st.mtimeMs < since) return undefined;
	let text: string;
	try {
		text = decodeUtf8(await fs.readRange(file.path, 0, Math.min(st.size, HEAD_MAX_BYTES)));
	} catch {
		return undefined;
	}
	const head = parseHead(text);
	if (!head || head.id !== (file.id ?? head.id)) return undefined;
	const snap: SessionSnapshot = {
		id: head.id,
		harness: HARNESS,
		provider: PROVIDER,
		cwd: head.cwd,
		updatedAt: st.mtimeMs,
	};
	if (head.startedAt != null) snap.startedAt = head.startedAt;
	if (head.title) snap.title = head.title;

	const headLines = st.size <= HEAD_MAX_BYTES ? text.split('\n') : completeLines(text, true);
	let headModel: string | undefined;
	let prompt: string | undefined;
	for (const line of headLines) {
		const entry = entryOf(parse(line));
		if (!entry) continue;
		if (entry.type === 'model_change' && typeof entry.row.model === 'string') {
			headModel = entry.row.model;
		}
		prompt ??= userTextOf(entry);
	}
	if (!snap.title) {
		// Only now is the body worth reading, and only if the head did not hold a prompt.
		if (!prompt && st.size > HEAD_MAX_BYTES) {
			for (const rec of await readRecords(fs, file.path).catch(() => [])) {
				const entry = entryOf(rec);
				prompt = entry ? userTextOf(entry) : undefined;
				if (prompt) break;
			}
		}
		if (prompt) snap.title = promptTitle(prompt);
	}
	const model = (await tailModel(fs, file.path, st.size).catch(() => undefined)) ?? headModel;
	if (model) snap.model = model;
	return snap;
}

export async function listSessions(
	fs: Fs,
	roots: Root[],
	opts: { since?: number; id?: string } = {},
): Promise<SessionSnapshot[]> {
	const out: SessionSnapshot[] = [];
	const seen = new Set<string>();
	for (const root of roots) {
		for (const file of await listSessionFiles(fs, root)) {
			if (file.id && ((opts.id && file.id !== opts.id) || seen.has(file.id))) continue;
			const snap = await snapshotOf(fs, file, opts.since);
			if (!snap || seen.has(snap.id) || (opts.id && snap.id !== opts.id)) continue;
			seen.add(snap.id);
			out.push(snap);
		}
	}
	return out;
}
