/**
 * `event_msg` types `should_persist_event_msg` keeps, copied from
 * `codex-rs/rollout/src/policy.rs` at openai/codex `7498521`. Not read from that
 * checkout at runtime.
 *
 * Always persisted: turn lifecycle, settings, token_count, item_completed (paginated
 * or a small legacy subset), thread_goal_updated, thread_rolled_back.
 * Legacy-only extras are listed too so a reducer rule for them is still "persisted".
 */
export const PERSISTED_EVENT_MSG_TYPES = [
	'item_completed',
	'token_count',
	'thread_goal_updated',
	'thread_rolled_back',
	'turn_aborted',
	'task_started',
	'turn_started',
	'task_complete',
	'turn_complete',
	'thread_settings_applied',
	'user_message',
	'agent_message',
	'agent_reasoning',
	'agent_reasoning_raw_content',
	'entered_review_mode',
	'exited_review_mode',
	'patch_apply_end',
	'context_compacted',
	'mcp_tool_call_end',
	'web_search_end',
	'image_generation_end',
	'sub_agent_activity',
] as const;

/** Types the Codex provider reducer inspects. Must be a subset of the persisted list. */
export const REDUCER_EVENT_MSG_TYPES = [
	'task_started',
	'turn_started',
	'task_complete',
	'turn_complete',
	'turn_aborted',
	'thread_settings_applied',
	'item_completed',
] as const;

export const TRANSIENT_EVENT_MSG_TYPES = [
	'error',
	'exec_approval_request',
	'apply_patch_approval_request',
	'request_permissions',
	'request_user_input',
	'elicitation_request',
	'exec_command_begin',
	'exec_command_end',
	'collab_agent_spawn_begin',
	'collab_agent_spawn_end',
	'mcp_startup_update',
	'mcp_startup_complete',
	'shutdown_complete',
] as const;
