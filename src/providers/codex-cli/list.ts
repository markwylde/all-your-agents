import { decodeUtf8 } from '../../helpers/bytes.ts';
import type { Fs } from '../../helpers/types.ts';
import type { SessionKind, SessionSnapshot, TitleSource } from '../../types.ts';
import { listRolloutFiles, parseRolloutHead, ROLLOUT_HEAD_BYTES } from './journal.ts';
import { sessionIndexPath } from './paths.ts';
import type { SessionMeta } from './session-meta.ts';

const INDEX_MAX_BYTES = 4 * 1024 * 1024;
const TITLE_MAX = 200;

export type IndexTitle = { title: string; at?: number };

export async function readSessionIndex(fs: Fs, home: string): Promise<Map<string, IndexTitle>> {
	const out = new Map<string, IndexTitle>();
	let bytes: Uint8Array;
	try {
		bytes = await fs.readFile(sessionIndexPath(home), { maxBytes: INDEX_MAX_BYTES });
	} catch {
		return out;
	}
	for (const line of decodeUtf8(bytes).split('\n')) {
		if (!line.trim()) continue;
		let raw: unknown;
		try {
			raw = JSON.parse(line);
		} catch {
			continue;
		}
		if (!raw || typeof raw !== 'object') continue;
		const row = raw as Record<string, unknown>;
		if (typeof row.id !== 'string' || typeof row.thread_name !== 'string') continue;
		const at = typeof row.updated_at === 'string' ? Date.parse(row.updated_at) : Number.NaN;
		out.set(row.id, {
			title: row.thread_name.slice(0, TITLE_MAX),
			at: Number.isFinite(at) ? at : undefined,
		});
	}
	return out;
}

export type Listed = SessionSnapshot & {
	titleSource?: TitleSource;
};

function kindOf(meta: SessionMeta | undefined): SessionKind {
	return meta?.kind ?? 'interactive';
}

export async function listSessions(
	fs: Fs,
	home: string,
	opts: { since?: number; id?: string } = {},
): Promise<Listed[]> {
	const files = await listRolloutFiles(fs, home);
	const titles = await readSessionIndex(fs, home);
	const byId = new Map<string, (typeof files)[number][]>();
	for (const file of files) {
		if (opts.id && file.threadId !== opts.id) continue;
		const list = byId.get(file.threadId) ?? [];
		list.push(file);
		byId.set(file.threadId, list);
	}
	const out: Listed[] = [];
	for (const [id, group] of byId) {
		group.sort((a, b) => {
			if (a.compressed !== b.compressed) return a.compressed ? 1 : -1;
			return (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0);
		});
		const chosen = group[0];
		if (!chosen) continue;
		if (opts.since != null && (chosen.mtimeMs ?? 0) < opts.since) continue;
		const index = titles.get(id);
		if (chosen.compressed) {
			if (!index) continue;
			const snap: Listed = {
				id,
				harness: 'Codex',
				provider: 'codex-cli',
				kind: 'interactive',
				title: index.title,
				titleSource: 'harness',
			};
			if (chosen.nameMs != null) snap.startedAt = chosen.nameMs;
			snap.updatedAt = chosen.mtimeMs ?? snap.startedAt;
			out.push(snap);
			continue;
		}
		let head: ReturnType<typeof parseRolloutHead> = {};
		try {
			head = parseRolloutHead(await fs.readRange(chosen.path, 0, ROLLOUT_HEAD_BYTES));
		} catch {
			continue;
		}
		if (head.meta && !head.meta.root) continue;
		const meta = head.meta;
		let title = index?.title;
		let titleSource: TitleSource | undefined = index ? 'harness' : undefined;
		if (!title && head.prompt) {
			title = head.prompt.slice(0, TITLE_MAX);
			titleSource = 'prompt';
		}
		const snap: Listed = {
			id,
			harness: 'Codex',
			provider: 'codex-cli',
			kind: kindOf(meta),
		};
		if (meta?.cwd) snap.cwd = meta.cwd;
		if (title) snap.title = title;
		if (titleSource) snap.titleSource = titleSource;
		if (meta?.timestamp != null) snap.startedAt = meta.timestamp;
		else if (chosen.nameMs != null) snap.startedAt = chosen.nameMs;
		snap.updatedAt = chosen.mtimeMs ?? snap.startedAt;
		if (head.model) snap.model = head.model;
		out.push(snap);
	}
	return out;
}
