## MODIFIED Requirements

### Requirement: Subagent lifecycle
The `collab_agent_*` events are never persisted. The provider SHALL discover a subagent from either of two persisted sources, whichever first supplies a child thread id:
- a sibling rollout whose `session_meta.parent_thread_id` equals this thread's id (with `thread_source` `subagent`). This is the only source guaranteed in every history mode and SHALL be sufficient on its own
- an `event_msg` `item_completed` on the parent rollout whose `item.type` is `CollabAgentToolCall` and `tool` is `spawn_agent` (`receiver_agents[].thread_id` and `.agent_nickname`). It is present only in `paginated` history mode and SHALL be treated as an optional earlier hint

It SHALL link them by the child thread id. Subagent fields come from these sources:
- `type` from the child `session_meta.agent_role` when present, otherwise `subagent`
- `title` from the child `session_meta.agent_nickname`, or `receiver_agents[].agent_nickname`
- `parentId` from the child `session_meta.parent_thread_id`: absent when that is the root thread, otherwise that subagent's thread id
- `background` false at start; it becomes true when the parent's turn ends while the child's turn is still open. Codex spawns every agent asynchronously and records no foreground/background flag, so this is the only observable distinction

Completion SHALL be recorded as follows, from the child's own rollout first:
- the child's `task_complete` with no `error` → `completed`
- the child's `task_complete` with `error` → `failed`
- the child's `turn_aborted` → `cancelled`
- a parent `CollabAgentToolCall` (`wait`, `close_agent`) whose `agents_states[childId]` is `completed` → `completed`; `errored` → `failed`; `interrupted`, `shutdown`, or `not_found` → `cancelled`; `pending_init` and `running` SHALL NOT end it
- parent session close while the child is still open → `cancelled` (core also cancels on close)

Whichever source reports first wins; a later one SHALL NOT emit a second `subagent:end`. A Codex agent can be sent further input after its first turn; a later `task_started` on an ended child SHALL NOT restart it or emit another `subagent:start`. A child still open when the parent goes `idle` SHALL stay open as `background`; the provider SHALL NOT cancel it on parent idle. At bind, a child whose rollout already shows an end SHALL be reported through `subagents()` without `subagent:start`, and a child still open SHALL emit `subagent:start`, including when the child rollout was found before its parent was bound. The provider SHALL watch the date directory so a child rollout is seen as soon as the file appears. Child rollouts SHALL NOT be emitted as root sessions.

#### Scenario: Collab agent finishes inside the parent turn
- **WHEN** a child rollout appears with this thread's `parent_thread_id` and `agent_nickname` `Sartre`, and the child records `task_complete` before the parent's `task_complete`
- **THEN** `subagent:start` fires with title `Sartre` and `background` false, then `subagent:end` with `completed`

#### Scenario: Background agent
- **WHEN** the parent records `task_complete` while the child's turn is still open, and later the child records `task_complete`
- **THEN** the subagent stays `running` through the parent idle with `background` true, then ends `completed`

#### Scenario: Legacy history mode
- **WHEN** the parent rollout holds no `CollabAgentToolCall` items at all and a child rollout appears
- **THEN** the subagent is still started, titled, and ended from the child rollout alone

#### Scenario: Both sources seen
- **WHEN** the parent's `spawn_agent` `item_completed` and the child rollout are both observed, in either order
- **THEN** exactly one `subagent:start` fires, not two

#### Scenario: Wait and child both report completion
- **WHEN** the child records `task_complete` and the parent later records a `wait` with `agents_states[childId]` `completed`
- **THEN** exactly one `subagent:end` fires

#### Scenario: Resumed session with prior subagents
- **WHEN** the provider binds to a resumed session whose history contains three finished child rollouts
- **THEN** `subagents()` returns three ended subagents and no `subagent:start` is emitted for them

#### Scenario: Running child found before the parent binds
- **WHEN** a child rollout that is still open is read before its parent's rollout is bound
- **THEN** `subagent:start` fires for it once when the parent binds

#### Scenario: Subagent transcript
- **WHEN** `transcript()` is called on a subagent
- **THEN** it replays that child's rollout, and its records do not affect the root session's activity
