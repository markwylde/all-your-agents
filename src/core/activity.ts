import type { SessionActivity, TurnFact } from '../types.js';

export function emptyActivity(): SessionActivity {
	return { openSubagents: 0 };
}

export function reduceActivity(activity: SessionActivity, fact: TurnFact): SessionActivity {
	switch (fact.type) {
		case 'turn-started':
			return { openSubagents: activity.openSubagents };
		case 'tool-started':
			return {
				...activity,
				tool: { id: fact.id, name: fact.name, startedAt: fact.startedAt },
			};
		case 'tool-finished': {
			if (activity.tool?.id !== fact.id) return activity;
			const next = { ...activity };
			delete next.tool;
			return next;
		}
		case 'turn-ended': {
			const next: SessionActivity = {
				openSubagents: activity.openSubagents,
				lastTurn: fact.outcome,
			};
			if (fact.endedAt != null) next.lastTurnEndedAt = fact.endedAt;
			if (fact.outcome === 'failed' && fact.error) next.error = fact.error;
			return next;
		}
	}
}

export function activityChanged(a: SessionActivity, b: SessionActivity): boolean {
	return JSON.stringify(normalize(a)) !== JSON.stringify(normalize(b));
}

function normalize(a: SessionActivity): unknown {
	return {
		openSubagents: a.openSubagents,
		tool: a.tool ?? null,
		lastTurn: a.lastTurn ?? null,
		lastTurnEndedAt: a.lastTurnEndedAt ?? null,
		error: a.error ?? null,
	};
}

export function withOpenSubagents(activity: SessionActivity, n: number): SessionActivity {
	if (activity.openSubagents === n) return activity;
	return { ...activity, openSubagents: n };
}
