import type { SessionEvent, Turn, TurnOutcome } from '../types.js';

export function groupTurns(events: SessionEvent[]): Turn[] {
	const turns: Turn[] = [];
	let current: SessionEvent[] | null = null;
	let outcome: TurnOutcome = 'open';
	let startedAt: number | undefined;
	let endedAt: number | undefined;

	const flush = (forced?: TurnOutcome): void => {
		if (!current) return;
		const turn: Turn = { events: current, outcome: forced ?? outcome };
		if (startedAt != null) turn.startedAt = startedAt;
		if (endedAt != null) turn.endedAt = endedAt;
		turns.push(turn);
		current = null;
		outcome = 'open';
		startedAt = undefined;
		endedAt = undefined;
	};

	for (const event of events) {
		if (event.kind === 'other') continue;
		if (event.kind === 'user') {
			if (current) flush(outcome === 'open' ? 'completed' : outcome);
			current = [event];
			startedAt = event.at;
			outcome = 'open';
			continue;
		}
		if (!current) continue;
		current.push(event);
		if (event.kind === 'turn-end') {
			outcome = event.outcome ?? 'completed';
			endedAt = event.at;
			flush();
		} else if (event.kind === 'error') {
			outcome = 'failed';
			endedAt = event.at;
		}
	}
	if (current) flush();
	return turns;
}
