import { join } from 'node:path';
import { decodeUtf8 } from '../../helpers/bytes.ts';
import type { Fs } from '../../helpers/types.ts';
import type { SessionEvent } from '../../types.ts';
import { derivedSessionDir, sessionsDir } from './paths.ts';
import { parseSpawnArgs, parseSpawnResult } from './subagents.ts';

/**
 * The session directory for this id: the one derived from its cwd, otherwise the only
 * `<cwd dir>/<id>/` one level below `sessions/`. Two of them is ambiguous: none.
 */
export async function resolveSessionDir(
	fs: Fs,
	home: string,
	sessionId: string,
	cwd?: string,
): Promise<string | undefined> {
	const derived = cwd ? derivedSessionDir(home, cwd, sessionId) : undefined;
	if (derived && (await fs.stat(derived).catch(() => null))?.isDirectory) return derived;
	const root = sessionsDir(home);
	let dirs: string[];
	try {
		dirs = await fs.readDir(root);
	} catch {
		return undefined;
	}
	let hit: string | undefined;
	for (const dir of dirs) {
		const candidate = join(root, dir, sessionId);
		if (!(await fs.stat(candidate).catch(() => null))?.isDirectory) continue;
		if (hit) return undefined;
		hit = candidate;
	}
	return hit;
}

/**
 * The cwd a `sessions/<cwd dir>` stands for. A URL-encoded name decodes to it; a long
 * cwd's slug-hash name does not, and Grok keeps the original in `.cwd` beside it.
 */
export async function cwdOfDir(fs: Fs, cwdDir: string, name: string): Promise<string | undefined> {
	if (name.startsWith('%')) {
		try {
			return decodeURIComponent(name);
		} catch {}
	}
	try {
		const text = decodeUtf8(await fs.readFile(join(cwdDir, '.cwd'), { maxBytes: 64 * 1024 }));
		return text.trim() || undefined;
	} catch {
		return undefined;
	}
}

export function textOf(content: unknown): string | undefined {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const part of content) {
		if (part && typeof part === 'object' && (part as { type?: string }).type === 'text') {
			const text = (part as { text?: unknown }).text;
			if (typeof text === 'string') parts.push(text);
		}
	}
	return parts.length ? parts.join('') : undefined;
}

/** The prompt itself: Grok wraps what the user typed in `<user_query>`. */
export function promptText(text: string): string {
	const inner = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(text)?.[1];
	return inner ?? text;
}

export function promptTitle(text: string): string {
	return text.slice(0, 200);
}

const isReminderOnly = (text: string): boolean => {
	const trimmed = text.trim();
	return trimmed.startsWith('<system-reminder>') && trimmed.endsWith('</system-reminder>');
};

/** Remembers what a mapping pass has seen, to drop a repeated prompt. */
export type ChatMapState = { lastPromptIndex?: number };

/** The model that wrote an assistant record, or undefined for any other record. */
export function modelOf(rec: unknown): string | undefined {
	if (!rec || typeof rec !== 'object') return undefined;
	const row = rec as Record<string, unknown>;
	if (row.type !== 'assistant') return undefined;
	return typeof row.model_id === 'string' && row.model_id ? row.model_id : undefined;
}

/**
 * One `chat_history.jsonl` record as normalized events. Chat records carry no
 * timestamps. Injected context, reminders, reasoning and system records map to nothing.
 */
export function mapChatRecord(rec: unknown, state: ChatMapState = {}): SessionEvent[] {
	if (!rec || typeof rec !== 'object') return [];
	const row = rec as Record<string, unknown>;
	const base = { raw: rec };
	if (row.type === 'user') {
		const reason = row.synthetic_reason;
		if (reason != null && reason !== 'human') return [];
		if (typeof row.prompt_index !== 'number') return [];
		const text = textOf(row.content);
		if (!text || isReminderOnly(text)) return [];
		if (state.lastPromptIndex === row.prompt_index) return [];
		state.lastPromptIndex = row.prompt_index;
		return [{ kind: 'user', text: promptText(text), ...base }];
	}
	if (row.type === 'assistant') {
		if (typeof row.error === 'string' && row.error) {
			return [{ kind: 'error', message: row.error, ...base }];
		}
		const events: SessionEvent[] = [];
		const text = textOf(row.content);
		if (text) events.push({ kind: 'assistant', text, model: modelOf(rec), ...base });
		const calls = Array.isArray(row.tool_calls) ? row.tool_calls : [];
		for (const call of calls) {
			if (!call || typeof call !== 'object') continue;
			const c = call as Record<string, unknown>;
			if (typeof c.id !== 'string' || typeof c.name !== 'string') continue;
			events.push({ kind: 'tool', id: c.id, name: c.name, ...base });
			if (c.name === 'spawn_subagent') {
				const args = parseSpawnArgs(c.arguments);
				events.push({
					kind: 'subagent',
					id: c.id,
					title: args.title,
					type: args.type,
					background: args.background,
					...base,
				});
			}
		}
		return events;
	}
	if (row.type === 'tool_result') {
		if (typeof row.tool_call_id !== 'string') return [];
		const events: SessionEvent[] = [
			{ kind: 'tool-result', id: row.tool_call_id, isError: row.is_error === true, ...base },
		];
		const text = textOf(row.content);
		if (text && parseSpawnResult(text).completed) {
			events.push({ kind: 'subagent-end', id: row.tool_call_id, status: 'completed', ...base });
		}
		return events;
	}
	return [];
}
