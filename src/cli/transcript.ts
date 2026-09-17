import type { SessionEvent } from '../index.ts';
import { type Style, sanitize, width } from './ansi.ts';
import { clockTime } from './format.ts';

export type TranscriptItem = {
	kind: 'user' | 'assistant' | 'tool' | 'tool-failed' | 'subagent' | 'error' | 'turn-end';
	text: string;
	at?: number;
	/** The model, on an assistant item. */
	note?: string;
};

export type TranscriptLine = { text: string; style: Style[] };

/**
 * Reduce session events to what the view shows, dropping the raw records. Stateful for
 * one stream: it remembers tool names so a failed result can name its tool, and keeps
 * only the first end of a turn, as the core does for activity.
 */
export function createItemizer(): (event: SessionEvent) => TranscriptItem[] {
	const toolNames = new Map<string, string>();
	let turnEnded = false;
	return (event) => {
		const at = event.at;
		switch (event.kind) {
			case 'user':
				turnEnded = false;
				return [{ kind: 'user', text: event.text, at }];
			case 'assistant':
				return [{ kind: 'assistant', text: event.text, at, note: event.model }];
			case 'tool':
				turnEnded = false;
				toolNames.set(event.id, event.name);
				return [{ kind: 'tool', text: event.name, at }];
			case 'tool-result':
				if (!event.isError) return [];
				return [{ kind: 'tool-failed', text: toolNames.get(event.id) ?? 'tool', at }];
			case 'subagent': {
				const what = [event.type, event.title].filter(Boolean).join(': ') || 'subagent';
				return [{ kind: 'subagent', text: event.background ? `${what} (background)` : what, at }];
			}
			case 'error':
				return [{ kind: 'error', text: event.message, at }];
			case 'turn-end':
				if (turnEnded) return [];
				turnEnded = true;
				return [{ kind: 'turn-end', text: event.outcome ?? 'completed', at }];
			default:
				return [];
		}
	};
}

const INDENT = '   ';

/** Word-wrap one paragraph of plain text to `room` columns, cutting words longer than a line. */
function wrapParagraph(text: string, room: number): string[] {
	const lines: string[] = [];
	let line = '';
	let used = 0;
	const flush = (): void => {
		lines.push(line);
		line = '';
		used = 0;
	};
	for (const word of text.split(' ')) {
		let rest = word;
		let w = width(rest);
		if (used > 0 && used + 1 + w <= room) {
			line += ` ${rest}`;
			used += 1 + w;
			continue;
		}
		if (used > 0) flush();
		while (w > room) {
			let cut = '';
			let cw = 0;
			for (const ch of rest) {
				const c = width(ch);
				if (cw + c > room) break;
				cut += ch;
				cw += c;
			}
			if (cut === '') cut = [...rest][0] ?? '';
			lines.push(cut);
			rest = rest.slice(cut.length);
			w = width(rest);
		}
		line = rest;
		used = w;
	}
	if (used > 0 || lines.length === 0) flush();
	return lines;
}

function wrapText(text: string, cols: number): string[] {
	const room = Math.max(8, cols - INDENT.length - 1);
	const out: string[] = [];
	for (const paragraph of text.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').split('\n')) {
		const clean = sanitize(paragraph).trimEnd();
		if (clean === '') {
			// Collapse runs of blank lines; never start with one.
			if (out.length > 0 && out[out.length - 1] !== '') out.push('');
			continue;
		}
		out.push(...wrapParagraph(clean, room));
	}
	while (out.length > 0 && out[out.length - 1] === '') out.pop();
	return out;
}

const stamp = (at: number | undefined): string => (at == null ? '' : ` · ${clockTime(at)}`);

type Speaker = 'you' | 'agent' | undefined;

function itemLines(
	item: TranscriptItem,
	cols: number,
	speaker: Speaker,
): { lines: TranscriptLine[]; speaker: Speaker } {
	const lines: TranscriptLine[] = [];
	const body = (text: string, style: Style[], prefix = ''): void => {
		const wrapped = wrapText(prefix + text, cols);
		for (const line of wrapped) lines.push({ text: line === '' ? '' : INDENT + line, style });
	};
	const agentHeader = (): void => {
		if (speaker === 'agent') return;
		const model = item.kind === 'assistant' && item.note ? ` · ${sanitize(item.note)}` : '';
		lines.push({ text: ` Agent${model}${stamp(item.at)}`, style: ['bold', 'cyan'] });
	};
	switch (item.kind) {
		case 'user':
			lines.push({ text: '', style: [] });
			lines.push({ text: ` You${stamp(item.at)}`, style: ['bold', 'green'] });
			body(item.text, []);
			return { lines, speaker: 'you' };
		case 'assistant':
			agentHeader();
			body(item.text, []);
			return { lines, speaker: 'agent' };
		case 'tool':
			agentHeader();
			body(item.text, ['dim'], '⚙ ');
			return { lines, speaker: 'agent' };
		case 'tool-failed':
			agentHeader();
			body(`${item.text} failed`, ['red'], '✗ ');
			return { lines, speaker: 'agent' };
		case 'subagent':
			agentHeader();
			body(item.text, ['dim'], '↳ ');
			return { lines, speaker: 'agent' };
		case 'error':
			body(item.text, ['red'], '! ');
			return { lines, speaker };
		case 'turn-end':
			lines.push({
				text: ` ── ${item.text}${stamp(item.at)}`,
				style: item.text === 'completed' ? ['dim'] : ['yellow'],
			});
			return { lines, speaker: undefined };
	}
}

type Cache = {
	cols: number;
	count: number;
	last: TranscriptItem | undefined;
	speaker: Speaker;
	lines: TranscriptLine[];
};

let cache: Cache | undefined;

/**
 * The wrapped lines for a transcript. Same input, same output; the work is remembered,
 * because both the reducer (to clamp scrolling) and the renderer ask on every key. Items
 * only ever grow at the end, so a longer list that extends the remembered one wraps only
 * what is new.
 */
export function transcriptLines(
	items: readonly TranscriptItem[],
	cols: number,
): readonly TranscriptLine[] {
	const extendsCache =
		cache !== undefined &&
		cache.cols === cols &&
		cache.count <= items.length &&
		(cache.count === 0 || items[cache.count - 1] === cache.last);
	let state: Cache =
		extendsCache && cache
			? cache
			: { cols, count: 0, last: undefined, speaker: undefined, lines: [] };
	if (state.count === items.length) {
		cache = state;
		return state.lines;
	}
	const lines = [...state.lines];
	let speaker = state.speaker;
	for (let i = state.count; i < items.length; i++) {
		const item = items[i];
		if (!item) continue;
		const next = itemLines(item, cols, speaker);
		// The blank line before a prompt separates turns; nothing precedes the first.
		lines.push(...(lines.length === 0 ? next.lines.filter((l, n) => n > 0 || l.text) : next.lines));
		speaker = next.speaker;
	}
	state = { cols, count: items.length, last: items[items.length - 1], speaker, lines };
	cache = state;
	return state.lines;
}
