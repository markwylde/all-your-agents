import type { SessionStatus } from '../../types.ts';

const START = new Set(['task_started', 'turn_started']);
const END = new Set(['task_complete', 'turn_complete', 'turn_aborted']);

/** Status from a persisted lifecycle event. Unknown types have none. Never `waiting`. */
export function lifecycleStatus(type: string | undefined): SessionStatus | undefined {
	if (type == null) return undefined;
	if (START.has(type)) return 'running';
	if (END.has(type)) return 'idle';
	return undefined;
}

export const knownLifecycleTypes = [...START, ...END];
