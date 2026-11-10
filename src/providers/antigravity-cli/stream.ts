import type { SessionEvent } from '../../types.ts';
import type { Reader } from './data.ts';
import { terminal } from './data.ts';
import { decodeStep } from './steps.ts';
import { type Metadata, metadata, records } from './storage.ts';

export type StreamState = { cursor: number; seen: Set<string>; tools: Set<string> };
export const streamState = (): StreamState => ({ cursor: -1, seen: new Set(), tools: new Set() });
/** Commit this returned state only after all reads and binding checks succeed. */
export async function readStream(ctx: Reader, path: string, previous: StreamState) {
	const state: StreamState = {
		cursor: previous.cursor,
		seen: new Set(previous.seen),
		tools: new Set(previous.tools),
	};
	const meta = await metadata(ctx, path);
	const events: SessionEvent[] = [];
	let gap = false,
		waitingFor: string | undefined,
		waiting = false,
		backgroundWait: string | undefined;
	const add = (index: number, event: SessionEvent) => {
		const key = `${index}:${event.kind}:${'id' in event ? event.id : event.kind === 'turn-end' ? event.outcome : ''}`;
		if (state.seen.has(key)) return;
		state.seen.add(key);
		if (event.kind === 'tool') {
			if (state.tools.has(event.id)) return;
			state.tools.add(event.id);
		}
		events.push(event);
	};
	const addEnding = (ending: Metadata['endings'][number], at?: number) => {
		if (ending.error)
			add(ending.index, { kind: 'error', message: ending.error, raw: ending.event.raw });
		add(ending.index, { ...ending.event, at });
	};
	for await (const row of records(ctx, path, previous.cursor)) {
		const index = Number(row.idx),
			done = terminal(row.status);
		const decoded = decodeStep(row, meta.models);
		if (!gap && done) state.cursor = index;
		if (!done) gap = true;
		if (decoded) {
			meta.model ??= decoded.model;
			backgroundWait ??= decoded.backgroundWait;
			if (row.status === 9) {
				waiting = true;
				waitingFor ??= decoded.waitingFor;
			}
			for (const event of decoded.events) {
				if (event.kind === 'turn-end' && meta.endings.some((e) => e.index === index)) continue;
				add(index, event);
			}
		}
		if (done)
			for (const ending of meta.endings)
				if (ending.index === index) addEnding(ending, decoded?.events.at(-1)?.at);
		if (!done && !decoded?.background && (row.step_type === 14 || row.step_type === 15)) break;
	}
	// Executor termination can be persisted after the last step was already consumed.
	for (const ending of meta.endings) if (ending.index <= state.cursor) addEnding(ending);
	return { state, events, model: meta.model, waiting, waitingFor, backgroundWait };
}
