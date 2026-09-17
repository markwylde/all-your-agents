import { join } from 'node:path';
import { decodeUtf8 } from '../../helpers/bytes.ts';
import type { Fs } from '../../helpers/types.ts';
import type { SessionEvent, SubagentStatus } from '../../types.ts';
import { derivedJournalPath, projectsDir } from './paths.ts';

const UNMAPPED = new Set([
	'queue-operation',
	'relocated',
	'worktree-state',
	'bridge-session',
	'file-history-delta',
	'file-history-snapshot',
	'attachment',
	'permission-mode',
	'mode',
	'atis-latch',
	'last-prompt',
	'frame-link',
	'cost-state',
	'pr-link',
	'artifact-autoreact-ledger',
	'artifact-comment-monitor',
]);

export function recordTime(rec: Record<string, unknown>): number | undefined {
	const ts = rec.timestamp;
	if (typeof ts === 'number') return ts;
	if (typeof ts === 'string') {
		const n = Date.parse(ts);
		return Number.isFinite(n) ? n : undefined;
	}
	return undefined;
}

export function isInjectedText(text: string): boolean {
	return (
		text.startsWith('<system-reminder>') ||
		text.startsWith('<command-name>') ||
		text.startsWith('<local-command-') ||
		text.startsWith('<task-notification>')
	);
}

export function isTaskNotification(rec: Record<string, unknown>, text?: string): boolean {
	const origin = rec.origin;
	if (
		origin &&
		typeof origin === 'object' &&
		(origin as { kind?: string }).kind === 'task-notification'
	) {
		return true;
	}
	return Boolean(text?.includes('<task-notification>'));
}

export function isInterruption(text: string): boolean {
	return text.startsWith('[Request interrupted by user');
}

export function contentOf(rec: Record<string, unknown>): unknown {
	const message = rec.message;
	if (message && typeof message === 'object' && 'content' in message) {
		return (message as { content: unknown }).content;
	}
	return rec.content;
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

/** Claude Code writes this on assistant records it generated itself, such as API errors. */
const SYNTHETIC_MODEL = '<synthetic>';

/** The model that produced an assistant record, or undefined for any other record. */
export function modelOf(rec: unknown): string | undefined {
	if (!rec || typeof rec !== 'object') return undefined;
	const row = rec as Record<string, unknown>;
	if (row.type !== 'assistant' || !row.message || typeof row.message !== 'object') return undefined;
	const model = (row.message as Record<string, unknown>).model;
	return typeof model === 'string' && model && model !== SYNTHETIC_MODEL ? model : undefined;
}

/** The title a session takes from its first real prompt. */
export function promptTitle(text: string): string {
	return text.slice(0, 200);
}

export function mapRecord(rec: unknown): SessionEvent[] {
	if (!rec || typeof rec !== 'object') return [];
	const row = rec as Record<string, unknown>;
	const type = row.type;
	const at = recordTime(row);
	const base = { raw: rec, ...(at != null ? { at } : {}) };

	if (typeof type === 'string' && UNMAPPED.has(type)) return [];
	if (type === 'system') {
		// Every other subtype is bookkeeping. `agents_killed` ends subagents, which the
		// live provider reports from the record itself since it names no subagent.
		if (row.subtype === 'turn_duration') {
			return [{ kind: 'turn-end', outcome: 'completed', ...base }];
		}
		return [];
	}
	if (type === 'ai-title') {
		const title = typeof row.aiTitle === 'string' ? row.aiTitle : undefined;
		if (!title) return [];
		return [{ kind: 'title', title, source: 'harness', ...base }];
	}
	if (type === 'custom-title') {
		const title = typeof row.customTitle === 'string' ? row.customTitle : undefined;
		if (!title) return [];
		return [{ kind: 'title', title, source: 'user', ...base }];
	}
	if (type === 'user') {
		const content = contentOf(row);
		const events: SessionEvent[] = [];
		if (Array.isArray(content)) {
			for (const part of content) {
				if (!part || typeof part !== 'object') continue;
				const p = part as Record<string, unknown>;
				if (p.type === 'tool_result' && typeof p.tool_use_id === 'string') {
					events.push({
						kind: 'tool-result',
						id: p.tool_use_id,
						isError: p.is_error === true,
						...base,
					});
				}
			}
		}
		const text = textOf(content);
		if (row.isMeta === true) return events;
		if (text && isTaskNotification(row, text)) return events;
		if (text && isInjectedText(text)) return events;
		if (text && isInterruption(text)) return events;
		if (text) events.push({ kind: 'user', text, ...base });
		return events;
	}
	if (type === 'assistant') {
		if (row.isApiErrorMessage === true) {
			const text = textOf(contentOf(row)) ?? 'API error';
			return [{ kind: 'error', message: text, ...base }];
		}
		const message =
			row.message && typeof row.message === 'object'
				? (row.message as Record<string, unknown>)
				: {};
		const model = modelOf(row);
		const content = contentOf(row);
		const events: SessionEvent[] = [];
		if (typeof content === 'string' && content) {
			events.push({ kind: 'assistant', text: content, model, ...base });
		}
		if (Array.isArray(content)) {
			const text = textOf(content);
			if (text) events.push({ kind: 'assistant', text, model, ...base });
			for (const part of content) {
				if (!part || typeof part !== 'object') continue;
				const p = part as Record<string, unknown>;
				if (p.type === 'tool_use' && typeof p.id === 'string' && typeof p.name === 'string') {
					events.push({ kind: 'tool', id: p.id, name: p.name, ...base });
					if (p.name === 'Agent' || p.name === 'Task') {
						const input =
							p.input && typeof p.input === 'object' ? (p.input as Record<string, unknown>) : {};
						events.push({
							kind: 'subagent',
							id: p.id,
							title: typeof input.description === 'string' ? input.description : undefined,
							type: typeof input.subagent_type === 'string' ? input.subagent_type : p.name,
							background: input.run_in_background === true,
							...base,
						});
					}
				}
			}
		}
		if (message.stop_reason === 'end_turn') {
			events.push({ kind: 'turn-end', outcome: 'completed', ...base });
		}
		return events;
	}
	return [];
}

export async function resolveJournal(
	fs: Fs,
	home: string,
	sessionId: string,
	cwd?: string,
): Promise<string | undefined> {
	if (cwd) {
		const derived = derivedJournalPath(home, cwd, sessionId);
		if (await acceptJournal(fs, derived, sessionId)) return derived;
	}
	const root = projectsDir(home);
	let dirs: string[] = [];
	try {
		dirs = await fs.readDir(root);
	} catch {
		return undefined;
	}
	const hits: string[] = [];
	for (const dir of dirs) {
		const candidate = join(root, dir, `${sessionId}.jsonl`);
		if (await acceptJournal(fs, candidate, sessionId)) hits.push(candidate);
		if (hits.length > 1) return undefined;
	}
	return hits[0];
}

async function acceptJournal(fs: Fs, path: string, sessionId: string): Promise<boolean> {
	const st = await fs.stat(path);
	if (!st?.isFile) return false;
	let bytes: Uint8Array;
	try {
		bytes = await fs.readRange(path, 0, 16 * 1024);
	} catch {
		return false;
	}
	const text = decodeUtf8(bytes);
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		try {
			const rec = JSON.parse(line) as Record<string, unknown>;
			if (rec.isSidechain === true) return false;
			if (rec.sessionId === sessionId) return true;
			if (rec.sessionId && rec.sessionId !== sessionId) return false;
		} catch {}
	}
	return false;
}

export function parseTaskNotification(text: string): {
	toolUseId?: string;
	status?: Exclude<SubagentStatus, 'running'>;
} {
	const id = /<tool-use-id>([^<]*)<\/tool-use-id>/.exec(text)?.[1];
	const statusWord = /<status>([^<]*)<\/status>/.exec(text)?.[1];
	let status: Exclude<SubagentStatus, 'running'> | undefined;
	if (statusWord === 'completed') status = 'completed';
	else if (statusWord === 'failed') status = 'failed';
	else if (statusWord === 'killed' || statusWord === 'stopped') status = 'cancelled';
	return { toolUseId: id, status };
}

export function toolResultText(part: Record<string, unknown>): string {
	const content = part.content;
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		return content
			.map((p) => (p && typeof p === 'object' ? String((p as { text?: unknown }).text ?? '') : ''))
			.join('');
	}
	try {
		return JSON.stringify(content);
	} catch {
		return '';
	}
}
