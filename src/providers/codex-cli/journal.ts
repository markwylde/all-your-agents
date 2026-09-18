import { join } from 'node:path';
import { decodeUtf8 } from '../../helpers/bytes.ts';
import type { Fs } from '../../helpers/types.ts';
import type { SessionEvent, SubagentStatus } from '../../types.ts';
import { envelope, eventMsgType, recordTime } from './events.ts';
import { filenameTimestampMs, parseRolloutName, sessionsDir } from './paths.ts';
import { parseSessionMeta, SESSION_META_MAX_BYTES } from './session-meta.ts';
import { completionOf, parseCollabItem, spawnIds } from './subagents.ts';

export type ChatMapState = {
	promptTitled?: boolean;
	model?: string;
};

/** First-line meta plus prompt/model from the same cheap head. */
export const ROLLOUT_HEAD_BYTES = 64 * 1024;

const USER_MESSAGE_BEGIN = '## My request for Codex:';

function blocks(content: unknown): Record<string, unknown>[] {
	if (typeof content === 'string') return [{ type: 'text', text: content }];
	if (Array.isArray(content)) {
		return content.filter((item) => item && typeof item === 'object') as Record<string, unknown>[];
	}
	if (content && typeof content === 'object') return [content as Record<string, unknown>];
	return [];
}

/** Environment/developer wrappers Codex injects as user-role `input_text`. */
export function isInjectedUserText(text: string): boolean {
	const t = text.trimStart();
	if (!t) return true;
	if (t.startsWith('<')) return true;
	if (t.startsWith('# AGENTS.md instructions')) return true;
	if (t.startsWith('These AGENTS.md instructions replace')) return true;
	if (t.startsWith('The previously provided AGENTS.md instructions')) return true;
	return false;
}

export function realUserText(content: unknown): string {
	const parts: string[] = [];
	for (const block of blocks(content)) {
		const type = block.type;
		if (type === 'reasoning' || type === 'thinking' || type === 'encrypted_content') continue;
		if (
			typeof type === 'string' &&
			type !== 'input_text' &&
			type !== 'output_text' &&
			type !== 'text'
		) {
			continue;
		}
		const text = block.text;
		if (typeof text !== 'string' || !text.trim()) continue;
		const at = text.indexOf(USER_MESSAGE_BEGIN);
		if (at >= 0) {
			const rest = text.slice(at + USER_MESSAGE_BEGIN.length).trim();
			if (rest) parts.push(rest);
			continue;
		}
		if (isInjectedUserText(text)) continue;
		parts.push(text);
	}
	return parts.join('\n');
}

export function textOf(
	content: unknown,
	kinds = new Set(['input_text', 'output_text', 'text']),
): string {
	const parts: string[] = [];
	for (const block of blocks(content)) {
		const type = block.type;
		if (type === 'reasoning' || type === 'thinking' || type === 'encrypted_content') continue;
		if (typeof type === 'string' && !kinds.has(type) && type !== 'text') continue;
		const text = block.text;
		if (typeof text === 'string' && text.trim() && !isInjectedUserText(text)) parts.push(text);
	}
	return parts.join('\n');
}

export function promptTitle(text: string): string {
	return text.slice(0, 200);
}

function callIdOf(payload: Record<string, unknown>): string | undefined {
	if (typeof payload.call_id === 'string' && payload.call_id) return payload.call_id;
	if (typeof payload.id === 'string' && payload.id) return payload.id;
	return undefined;
}

function toolNameOf(payload: Record<string, unknown>): string {
	if (typeof payload.name === 'string' && payload.name) return payload.name;
	if (payload.type === 'local_shell_call') return 'local_shell';
	if (payload.type === 'web_search_call') return 'web_search';
	if (payload.type === 'image_generation_call') return 'image_generation';
	return 'exec';
}

function errorMessage(payload: Record<string, unknown>): string | undefined {
	const error = payload.error;
	if (!error) return undefined;
	if (typeof error === 'string') return error;
	if (typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
		return (error as { message: string }).message;
	}
	return undefined;
}

export function modelOf(rec: unknown): string | undefined {
	const env = envelope(rec);
	if (!env) return undefined;
	if (env.type === 'event_msg' && eventMsgType(env.payload) === 'thread_settings_applied') {
		const settings = env.payload.thread_settings;
		if (settings && typeof settings === 'object') {
			const model = (settings as { model?: unknown }).model;
			if (typeof model === 'string' && model) return model;
		}
	}
	if (env.type === 'turn_context' && typeof env.payload.model === 'string') {
		return env.payload.model;
	}
	return undefined;
}

/** Map one rollout record. `item_completed` duplicates of `response_item` are skipped. */
export function mapRecord(rec: unknown, state: ChatMapState = {}): SessionEvent[] {
	const env = envelope(rec);
	if (!env) return [];
	const at = env.at ?? recordTime(env.payload);
	if (env.type === 'event_msg') {
		const kind = eventMsgType(env.payload);
		if (kind === 'task_complete' || kind === 'turn_complete') {
			const error = errorMessage(env.payload);
			const out: SessionEvent[] = [];
			if (error) out.push({ kind: 'error', message: error, raw: rec, at });
			out.push({ kind: 'turn-end', outcome: error ? 'failed' : 'completed', raw: rec, at });
			return out;
		}
		if (kind === 'turn_aborted') {
			return [{ kind: 'turn-end', outcome: 'interrupted', raw: rec, at }];
		}
		if (kind === 'item_completed') {
			const hint = parseCollabItem(env.payload.item);
			if (!hint) return [];
			const out: SessionEvent[] = [];
			for (const id of spawnIds(hint)) {
				out.push({
					kind: 'subagent',
					id,
					title: hint.nicknames.get(id),
					type: 'subagent',
					background: false,
					raw: rec,
					at,
				});
			}
			for (const [id, status] of hint.states) {
				if (status === 'open' || status === 'running') continue;
				if (completionOf(hint, id)) {
					out.push({ kind: 'subagent-end', id, status, raw: rec, at });
				}
			}
			return out;
		}
		return [];
	}
	if (env.type !== 'response_item') return [];
	const itemType = env.payload.type;
	if (itemType === 'message') {
		const role = env.payload.role;
		if (role === 'user') {
			const text = realUserText(env.payload.content);
			if (!text) return [];
			return [{ kind: 'user', text, raw: rec, at }];
		}
		const text = textOf(env.payload.content);
		if (!text) return [];
		if (role === 'assistant') {
			const event: SessionEvent = { kind: 'assistant', text, raw: rec, at };
			if (state.model) event.model = state.model;
			return [event];
		}
		return [];
	}
	if (
		itemType === 'function_call' ||
		itemType === 'custom_tool_call' ||
		itemType === 'local_shell_call' ||
		itemType === 'web_search_call' ||
		itemType === 'image_generation_call'
	) {
		const id = callIdOf(env.payload) ?? toolNameOf(env.payload);
		return [{ kind: 'tool', id, name: toolNameOf(env.payload), raw: rec, at }];
	}
	if (itemType === 'function_call_output' || itemType === 'custom_tool_call_output') {
		const id = callIdOf(env.payload);
		if (!id) return [];
		const isError = env.payload.success === false;
		return [{ kind: 'tool-result', id, isError, raw: rec, at }];
	}
	return [];
}

export type FoundRollout = {
	path: string;
	threadId: string;
	compressed: boolean;
	mtimeMs?: number;
	nameMs?: number;
};

export async function walkDateDirs(
	fs: Fs,
	root: string,
	visit: (dir: string, names: string[]) => Promise<void>,
): Promise<void> {
	let years: string[];
	try {
		years = await fs.readDir(root);
	} catch {
		return;
	}
	for (const year of years) {
		if (!/^\d{4}$/.test(year)) continue;
		const yearDir = join(root, year);
		let months: string[];
		try {
			months = await fs.readDir(yearDir);
		} catch {
			continue;
		}
		for (const month of months) {
			if (!/^\d{2}$/.test(month)) continue;
			const monthDir = join(yearDir, month);
			let days: string[];
			try {
				days = await fs.readDir(monthDir);
			} catch {
				continue;
			}
			for (const day of days) {
				if (!/^\d{2}$/.test(day)) continue;
				const dayDir = join(monthDir, day);
				let names: string[];
				try {
					names = await fs.readDir(dayDir);
				} catch {
					continue;
				}
				await visit(dayDir, names);
			}
		}
	}
}

export async function listRolloutFiles(fs: Fs, home: string): Promise<FoundRollout[]> {
	const out: FoundRollout[] = [];
	await walkDateDirs(fs, sessionsDir(home), async (dir, names) => {
		for (const name of names) {
			const parsed = parseRolloutName(name);
			if (!parsed) continue;
			const path = join(dir, name);
			const st = await fs.stat(path).catch(() => null);
			out.push({
				path,
				threadId: parsed.threadId,
				compressed: parsed.compressed,
				mtimeMs: st?.mtimeMs,
				nameMs: filenameTimestampMs(parsed.timestamp),
			});
		}
	});
	return out;
}

/** Newest plain file for this thread id; compressed only if no plain exists. Ambiguous plains → none. */
export async function resolveRollout(
	fs: Fs,
	home: string,
	threadId: string,
): Promise<string | undefined> {
	const files = (await listRolloutFiles(fs, home)).filter((file) => file.threadId === threadId);
	const plains = files.filter((file) => !file.compressed);
	if (plains.length > 1) {
		plains.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
		return plains[0]?.path;
	}
	if (plains.length === 1) return plains[0]?.path;
	const zst = files.filter((file) => file.compressed);
	if (zst.length === 1) return zst[0]?.path;
	if (zst.length > 1) {
		zst.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
		return zst[0]?.path;
	}
	return undefined;
}

export async function readMetaAt(
	fs: Fs,
	path: string,
): Promise<ReturnType<typeof parseSessionMeta>> {
	if (path.endsWith('.zst')) return undefined;
	try {
		const head = await fs.readRange(path, 0, ROLLOUT_HEAD_BYTES);
		const meta = parseSessionMeta(head);
		if (meta) return meta;
		const nl = decodeUtf8(head).includes('\n');
		if (nl || head.byteLength < ROLLOUT_HEAD_BYTES) return undefined;
		return parseSessionMeta(await fs.readRange(path, 0, SESSION_META_MAX_BYTES));
	} catch {
		return undefined;
	}
}

export type RolloutHead = {
	meta?: ReturnType<typeof parseSessionMeta>;
	prompt?: string;
	model?: string;
};

export function parseRolloutHead(bytes: Uint8Array): RolloutHead {
	const out: RolloutHead = { meta: parseSessionMeta(bytes) };
	for (const line of decodeUtf8(bytes).split('\n')) {
		if (!line.trim()) continue;
		let rec: unknown;
		try {
			rec = JSON.parse(line);
		} catch {
			continue;
		}
		const model = modelOf(rec);
		if (model) out.model = model;
		if (!out.prompt) {
			for (const event of mapRecord(rec)) {
				if (event.kind === 'user' && event.text) {
					out.prompt = event.text;
					break;
				}
			}
		}
	}
	return out;
}

export async function firstUserPrompt(fs: Fs, path: string): Promise<string | undefined> {
	if (path.endsWith('.zst')) return undefined;
	try {
		return parseRolloutHead(await fs.readRange(path, 0, ROLLOUT_HEAD_BYTES)).prompt;
	} catch {
		return undefined;
	}
}

/** Last persisted lifecycle outcome; an open turn in history is cancelled. */
export async function childHistoryStatus(
	fs: Fs,
	path: string,
): Promise<Exclude<SubagentStatus, 'running'>> {
	try {
		const st = await fs.stat(path);
		if (!st) return 'cancelled';
		const from = Math.max(0, st.size - ROLLOUT_HEAD_BYTES);
		const text = decodeUtf8(await fs.readRange(path, from));
		let last: Exclude<SubagentStatus, 'running'> | 'running' = 'running';
		for (const line of text.split('\n')) {
			if (!line.trim()) continue;
			let rec: unknown;
			try {
				rec = JSON.parse(line);
			} catch {
				continue;
			}
			const env = envelope(rec);
			if (env?.type !== 'event_msg') continue;
			const kind = eventMsgType(env.payload);
			if (kind === 'task_started' || kind === 'turn_started') last = 'running';
			else if (kind === 'turn_aborted') last = 'cancelled';
			else if (kind === 'task_complete' || kind === 'turn_complete') {
				last = errorMessage(env.payload) ? 'failed' : 'completed';
			}
		}
		return last === 'running' ? 'cancelled' : last;
	} catch {
		return 'cancelled';
	}
}
