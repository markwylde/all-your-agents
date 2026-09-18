import type { TurnFact } from '../../types.ts';
import { type EventsState, initialEventsState, reduceRecord } from './events.ts';

export function replayRecords(
	records: unknown[],
	state: EventsState = initialEventsState(),
): { state: EventsState; facts: TurnFact[] } {
	const facts: TurnFact[] = [];
	for (const rec of records) facts.push(...reduceRecord(state, rec));
	return { state, facts };
}
