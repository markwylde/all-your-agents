import type { TurnFact } from '../../types.ts';
import { type EventsState, endStaleTurn, replayRecords } from './events.ts';

/**
 * A transcript that predates us, replayed silently. A turn still open from before the
 * bound process started was cut off by that process's predecessor.
 */
export function replaySeed(
	records: unknown[],
	processStart: number | undefined,
): { state: EventsState; facts: TurnFact[] } {
	const replay = replayRecords(records);
	replay.facts.push(...endStaleTurn(replay.state, processStart));
	return replay;
}
