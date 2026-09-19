import { decodeUtf8 } from '../../helpers/bytes.ts';
import { tailJsonl } from '../../helpers/tail-jsonl.ts';
import type { Fs } from '../../helpers/types.ts';
import { watchFile } from '../../helpers/watch-file.ts';
import type { SessionEvent, SubagentStatus } from '../../types.ts';
import {
	blocksOf,
	childOutcome,
	entryOf,
	initialEventsState,
	modelOf,
	textOf,
	titleChangeOf,
} from './events.ts';

export type ChatMapState = {
	/** Subagents already announced, and already ended, so neither is yielded twice. */
	started?: Set<string>;
	ended?: Set<string>;
};

export function promptTitle(text: string): string {
	return text.slice(0, 200);
}

type Ended = Exclude<SubagentStatus, 'running'>;

function endedStatus(status: unknown): Ended | undefined {
	if (status === 'completed' || status === 'success') return 'completed';
	if (status === 'failed' || status === 'error') return 'failed';
	if (status === 'cancelled' || status === 'aborted' || status === 'canceled') return 'cancelled';
	return undefined;
}

function rows(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object',
	);
}

/**
 * Subagents as the parent transcript reports them: the `task` result lists the agents it
 * spawned (`progress`), and later `task` / `hub` results report their final states.
 */
function subagentEvents(
	message: Record<string, unknown>,
	raw: unknown,
	at: number | undefined,
	state: ChatMapState,
): SessionEvent[] {
	const details = message.details;
	if (!details || typeof details !== 'object') return [];
	const d = details as Record<string, unknown>;
	const out: SessionEvent[] = [];
	state.started ??= new Set();
	state.ended ??= new Set();
	if (message.toolName === 'task') {
		for (const row of rows(d.progress)) {
			if (typeof row.id !== 'string' || !row.id || state.started.has(row.id)) continue;
			state.started.add(row.id);
			const event: SessionEvent = { kind: 'subagent', id: row.id, title: row.id, raw, at };
			if (typeof row.agent === 'string' && row.agent) event.type = row.agent;
			if (d.async && typeof d.async === 'object') event.background = true;
			out.push(event);
		}
	}
	for (const { id, status } of reportedOutcomes({ type: 'message', message })) {
		if (!state.started.has(id) || state.ended.has(id)) continue;
		state.ended.add(id);
		out.push({ kind: 'subagent-end', id, status, raw, at });
	}
	return out;
}

const TASK_RESULT = /<task-result\b[^>]*?\bid="([^"]+)"[^>]*?\bstatus="([a-z]+)"/g;

/**
 * What a parent's transcript says became of the agents it spawned: a `task` or `hub`
 * result listing finished jobs, or the `async-result` note omp injects when a background
 * agent reports back.
 */
export function reportedOutcomes(rec: unknown): { id: string; status: Ended }[] {
	const entry = entryOf(rec);
	if (!entry) return [];
	const out: { id: string; status: Ended }[] = [];
	if (entry.type === 'custom_message') {
		if (entry.row.customType !== 'async-result') return out;
		const content = entry.row.content;
		const text = typeof content === 'string' ? content : textOf({ content });
		for (const match of text.matchAll(TASK_RESULT)) {
			const status = endedStatus(match[2]);
			if (match[1] && status) out.push({ id: match[1], status });
		}
		return out;
	}
	const details = entry.message?.role === 'toolResult' ? entry.message.details : undefined;
	if (!details || typeof details !== 'object') return out;
	const d = details as Record<string, unknown>;
	for (const row of [...rows(d.results), ...rows(d.jobs)]) {
		const status = endedStatus(row.status);
		if (typeof row.id === 'string' && row.id && status) out.push({ id: row.id, status });
	}
	return out;
}

/** Ids of the agents a `task` result spawned in the background (`details.async`). */
export function asyncAgentIds(rec: unknown): string[] {
	const message = entryOf(rec)?.message;
	if (message?.role !== 'toolResult' || message.toolName !== 'task') return [];
	const details = message.details as Record<string, unknown> | undefined;
	if (!details?.async || typeof details.async !== 'object') return [];
	return rows(details.progress)
		.map((row) => row.id)
		.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/** One transcript entry as normalized events. Bookkeeping entries map to nothing. */
export function mapRecord(rec: unknown, state: ChatMapState = {}): SessionEvent[] {
	const entry = entryOf(rec);
	if (!entry) return [];
	const { at } = entry;
	const titled = titleChangeOf(entry);
	if (titled) return [{ kind: 'title', title: titled.title, source: titled.source, raw: rec, at }];
	if (entry.type !== 'message' || !entry.message) return [];
	const message = entry.message;

	if (message.role === 'user') {
		const text = textOf(message);
		return text ? [{ kind: 'user', text, raw: rec, at }] : [];
	}

	if (message.role === 'toolResult') {
		if (typeof message.toolCallId !== 'string' || !message.toolCallId) return [];
		return [
			{
				kind: 'tool-result',
				id: message.toolCallId,
				isError: message.isError === true,
				raw: rec,
				at,
			},
			...subagentEvents(message, rec, at, state),
		];
	}

	if (message.role !== 'assistant') return [];
	const out: SessionEvent[] = [];
	const model = modelOf(message);
	for (const block of blocksOf(message)) {
		if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
			out.push({ kind: 'assistant', text: block.text, model, raw: rec, at });
		} else if (block.type === 'toolCall') {
			const name = typeof block.name === 'string' && block.name ? block.name : 'tool';
			const id = typeof block.id === 'string' && block.id ? block.id : name;
			out.push({ kind: 'tool', id, name, raw: rec, at });
		}
	}
	switch (message.stopReason) {
		case 'stop':
		case 'length':
			out.push({ kind: 'turn-end', outcome: 'completed', raw: rec, at });
			break;
		case 'error': {
			const text = typeof message.errorMessage === 'string' ? message.errorMessage : 'error';
			out.push({ kind: 'error', message: text, raw: rec, at });
			out.push({ kind: 'turn-end', outcome: 'failed', raw: rec, at });
			break;
		}
		case 'aborted':
			out.push({ kind: 'turn-end', outcome: 'interrupted', raw: rec, at });
			break;
	}
	return out;
}

export async function readRecords(fs: Fs, path: string): Promise<unknown[]> {
	const st = await fs.stat(path);
	if (!st?.isFile) return [];
	const text = decodeUtf8(await fs.readRange(path, 0, st.size));
	const out: unknown[] = [];
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line));
		} catch {
			// a line still being written
		}
	}
	return out;
}

/** `agent` from the child's `session_init` entry: the kind of subagent it is. */
export function agentTypeOf(rec: unknown): string | undefined {
	const entry = entryOf(rec);
	if (entry?.type !== 'session_init') return undefined;
	return typeof entry.row.agent === 'string' && entry.row.agent ? entry.row.agent : undefined;
}

/** A finished child's status from its own transcript, if it says how it ended. */
export async function childHistory(
	fs: Fs,
	path: string,
): Promise<{ status?: Ended; type?: string; endedAt?: number }> {
	const state = initialEventsState();
	let type: string | undefined;
	for (const rec of await readRecords(fs, path).catch(() => [])) {
		type ??= agentTypeOf(rec);
		const outcome = childOutcome(state, rec);
		if (outcome) return { status: outcome.status, type, endedAt: outcome.at };
	}
	return { type };
}

/**
 * Stored records, then appended ones, until aborted. omp sometimes replaces a transcript by
 * renaming a rewrite over it; a tail is attached to the file it opened, so the replacement
 * is re-opened and the records already yielded are skipped.
 */
export async function* followRecords(
	fs: Fs,
	path: string,
	signal?: AbortSignal,
): AsyncGenerator<unknown> {
	let yielded = 0;
	for (;;) {
		if (signal?.aborted) return;
		const skip = yielded;
		const ino = (await fs.stat(path).catch(() => null))?.ino;
		const tail = tailJsonl(fs, path);
		let replaced = false;
		const watch = watchFile(fs, path, () => {
			void fs
				.stat(path)
				.catch(() => null)
				.then((st) => {
					if (st?.ino == null || ino == null || st.ino === ino) return;
					replaced = true;
					tail.close();
				});
		});
		const stop = (): void => tail.close();
		signal?.addEventListener('abort', stop, { once: true });
		let seen = 0;
		try {
			for await (const rec of tail) {
				seen++;
				if (seen <= skip) continue;
				yielded++;
				yield rec;
			}
		} finally {
			signal?.removeEventListener('abort', stop);
			watch.close();
			tail.close();
		}
		if (!replaced) return;
	}
}
