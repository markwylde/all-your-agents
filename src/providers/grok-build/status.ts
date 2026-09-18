import type { SessionStatus } from '../../types.ts';

const RUNNING = new Set([
	'waiting_for_model',
	'streaming_text',
	'streaming_reasoning',
	'tool_execution',
]);

/** Status for an `events.jsonl` phase inside an open turn. Unknown phases have none. */
export function phaseStatus(phase: string | undefined): SessionStatus | undefined {
	if (phase == null) return 'running';
	if (RUNNING.has(phase)) return 'running';
	if (phase === 'permission_prompt') return 'waiting';
	return undefined;
}

export const knownPhases = [...RUNNING, 'permission_prompt'];
