import type { TurnFact } from '../../types.ts';
import {
	isInjectedText,
	isInterruption,
	isTaskNotification,
	recordTime,
	toolResultText,
} from './journal.ts';

function contentOf(rec: Record<string, unknown>): unknown {
	const message = rec.message;
	if (message && typeof message === 'object' && 'content' in message) {
		return (message as { content: unknown }).content;
	}
	return rec.content;
}

function textOf(content: unknown): string | undefined {
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

export function turnFactsFromRecord(rec: unknown): TurnFact[] {
	if (!rec || typeof rec !== 'object') return [];
	const row = rec as Record<string, unknown>;
	const at = recordTime(row);
	const type = row.type;
	if (type === 'queue-operation') return [];
	if (type === 'user') {
		const content = contentOf(row);
		const facts: TurnFact[] = [];
		if (Array.isArray(content)) {
			for (const part of content) {
				if (!part || typeof part !== 'object') continue;
				const p = part as Record<string, unknown>;
				if (p.type === 'tool_result' && typeof p.tool_use_id === 'string') {
					facts.push({ type: 'tool-finished', id: p.tool_use_id, at });
				}
			}
		}
		const text = textOf(content);
		if (row.isMeta === true) return facts;
		if (text && isTaskNotification(row, text)) return facts;
		if (text && isInjectedText(text)) return facts;
		if (text && isInterruption(text)) {
			facts.push({ type: 'turn-ended', outcome: 'interrupted', endedAt: at });
			return facts;
		}
		if (text) facts.push({ type: 'turn-started', at });
		return facts;
	}
	if (type === 'assistant') {
		const facts: TurnFact[] = [];
		if (row.isApiErrorMessage === true) {
			const text = textOf(contentOf(row)) ?? 'API error';
			facts.push({ type: 'turn-ended', outcome: 'failed', error: text, endedAt: at });
			return facts;
		}
		const content = contentOf(row);
		const message =
			row.message && typeof row.message === 'object'
				? (row.message as Record<string, unknown>)
				: {};
		if (Array.isArray(content)) {
			for (const part of content) {
				if (!part || typeof part !== 'object') continue;
				const p = part as Record<string, unknown>;
				if (p.type === 'tool_use' && typeof p.id === 'string' && typeof p.name === 'string') {
					facts.push({ type: 'tool-started', id: p.id, name: p.name, startedAt: at });
				}
				void toolResultText;
			}
		}
		if (message.stop_reason === 'end_turn') {
			facts.push({ type: 'turn-ended', outcome: 'completed', endedAt: at });
		}
		return facts;
	}
	if (type === 'system' && row.subtype === 'turn_duration') {
		return [{ type: 'turn-ended', outcome: 'completed', endedAt: at }];
	}
	return [];
}

export function closeOpenTurn(hasOpenTool: boolean, at?: number): TurnFact {
	return {
		type: 'turn-ended',
		outcome: hasOpenTool ? 'interrupted' : 'completed',
		endedAt: at,
	};
}
