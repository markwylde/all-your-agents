/**
 * Transcript entry types, copied from `packages/coding-agent/src/session/session-entries.ts`
 * at oh-my-pi `78b7531` (`@oh-my-pi/pi-coding-agent` 18.2.6). Not read from that checkout
 * at runtime. `title` is the fixed-width slot on line 1; `session` is the header.
 */
export const PERSISTED_ENTRY_TYPES = [
	'title',
	'session',
	'message',
	'model_usage',
	'thinking_level_change',
	'model_change',
	'service_tier_change',
	'compaction',
	'branch_summary',
	'reset_boundary',
	'custom',
	'label',
	'title_change',
	'ttsr_injection',
	'credential_pin',
	'session_init',
	'mode_change',
	'custom_message',
] as const;

/** `StopReason` in `packages/ai/src/types.ts` at the same commit. */
export const PERSISTED_STOP_REASONS = ['stop', 'length', 'toolUse', 'error', 'aborted'] as const;

/** `customType` values omp's own session code writes (`agent-session.ts`). */
export const PERSISTED_CUSTOM_TYPES = ['tool_execution_start', 'session_exit'] as const;

/** Message roles a transcript holds. */
export const PERSISTED_ROLES = [
	'user',
	'assistant',
	'toolResult',
	'developer',
	'fileMention',
] as const;

/** What the reducer and mapper act on. Each must be in the lists above. */
export const REDUCER_ENTRY_TYPES = [
	'message',
	'model_change',
	'custom',
	'custom_message',
	'title_change',
	'session_init',
] as const;
export const REDUCER_STOP_REASONS = ['stop', 'length', 'error', 'aborted'] as const;
export const REDUCER_CUSTOM_TYPES = ['tool_execution_start', 'session_exit'] as const;
export const REDUCER_ROLES = ['user', 'assistant', 'toolResult'] as const;
