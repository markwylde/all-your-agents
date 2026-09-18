import type { TurnFact } from '../../types.ts';
import { type EventsState, initialEventsState, reduceEvent } from './events.ts';

/**
 * A failed turn's message: `turn_ended` has none, so it comes from the conversation's
 * error record for that turn when there is one.
 */
export function withError(fact: TurnFact, error: string | undefined): TurnFact {
	if (fact.type !== 'turn-ended' || fact.outcome !== 'failed' || !error) return fact;
	return { ...fact, error };
}

/** Replay a whole `events.jsonl` into its final state and the facts that led there. */
export function replayEvents(
	records: unknown[],
	error?: string,
	state: EventsState = initialEventsState(),
): { state: EventsState; facts: TurnFact[] } {
	const facts: TurnFact[] = [];
	for (const rec of records) {
		for (const fact of reduceEvent(state, rec)) facts.push(withError(fact, error));
	}
	return { state, facts };
}
