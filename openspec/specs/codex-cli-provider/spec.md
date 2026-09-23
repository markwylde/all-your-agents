# codex-cli-provider Specification

## Purpose
Observes Codex CLI sessions from the rollout files Codex itself writes, and exposes them through the harness-neutral session API as a third built-in provider beside Claude Code and Grok Build.

## Requirements

### Requirement: Built in by default, isolated in code
The Codex CLI provider SHALL be included in `builtInProviders` and SHALL also be importable on its own. The provider id SHALL be `codex-cli` and the harness SHALL be `Codex`. Its Codex home SHALL default to `$CODEX_HOME` when set, otherwise `~/.codex`, and SHALL be configurable, so tests can point it at a temporary directory. VS Code Codex sessions that share that home and the same rollout format SHALL be observed by this provider; they SHALL NOT be a separate harness.

#### Scenario: Custom home
- **WHEN** the provider is created with a home pointing at a fixture directory
- **THEN** it reads only beneath that directory

#### Scenario: Home from the environment
- **WHEN** `CODEX_HOME` is set and no home is passed
- **THEN** the provider reads beneath that directory

### Requirement: Live sessions from open rollout files
The provider SHALL treat a root rollout file as live only while a process currently has that file open. The live set SHALL be discovered by a one-time holders probe (`heldUnder` / `holders`) in response to start or to a filesystem notification, never by mtime, "newest file", or a timer. Codex writes no pid index; `process_manager/chat_processes.json` is exec-child bookkeeping and SHALL NOT be used as a live index.

A rollout is a file matching `sessions/YYYY/MM/DD/rollout-*.jsonl`. Compressed `*.jsonl.zst` files SHALL NOT be opened. A rollout is a root only when `session_meta` has no `parent_thread_id` and `thread_source` is not `subagent`, `guardian_review`, or `memory_consolidation`. User forks (`forked_from_id` set, no `parent_thread_id`) SHALL still be roots.

Codex defers creating a new rollout until the thread's first items are written (`deferred_creation` in `rollout/src/recorder.rs`), so a freshly launched Codex with no prompt yet has no file and SHALL NOT be a session. A resumed thread reopens its existing rollout and keeps it open. On macOS a directory watch reports nothing for writes through a held handle, so rollout appends SHALL NOT be how a resume is discovered. Codex creates `<home>/thread-writer-locks/<thread-id>.lock` when a process opens a thread for writing and holds it open while the thread is live (ADR 0002). The provider SHALL watch that directory. When a lock appears for a thread with an existing plain rollout, the provider SHALL take the pid from `holders` of the lock and bind that rollout. A lock for a thread with no rollout yet SHALL bind nothing; the day directory reports the rollout when Codex creates it. A resume that happens before `watch` starts SHALL be found by the start probe. The provider SHALL NOT probe on a timer, and SHALL NOT watch rollout files one by one to find resumes. `holders` and `heldUnder` SHALL never report the observing process.

#### Scenario: Open file is live
- **WHEN** a Codex process has `sessions/2026/09/18/rollout-…-<id>.jsonl` open and that file's `session_meta` has no `parent_thread_id`
- **THEN** that thread is bound as a live session with that process's pid

#### Scenario: Closed file is history only
- **WHEN** a rollout exists on disk but no process has it open
- **THEN** no live session event is emitted for it

#### Scenario: Subagent rollout is not a root
- **WHEN** a rollout's `session_meta` has `parent_thread_id` set and `thread_source` `subagent`
- **THEN** it is not emitted as a live session, even if a process has it open

#### Scenario: Launched but no prompt yet
- **WHEN** a Codex process is running and has not yet written a rollout
- **THEN** no session exists for it, and `session:create` fires when its rollout file appears and is held

#### Scenario: Resumed before start
- **WHEN** a process resumed an old rollout before `watch` started and has appended nothing since
- **THEN** the start probe binds it and `session:open` is part of catch-up

#### Scenario: Resumed after start
- **WHEN** a process resumes an old rollout after `watch` started, and has appended nothing
- **THEN** its thread lock appears, and `session:open` fires with the lock holder's pid

#### Scenario: Resumed again after quitting
- **WHEN** a TUI quits leaving its lock behind, and a later process deletes and recreates that lock
- **THEN** the new process is bound

#### Scenario: Turn left open by a killed process
- **WHEN** a resumed rollout's replay ends with a turn that started before the holding process did, with no end record
- **THEN** that turn ends as interrupted at the process start, and the session is `idle` until a new turn starts

#### Scenario: Lock before rollout
- **WHEN** a lock appears for a thread with no rollout
- **THEN** nothing is bound until the rollout is created and held

#### Scenario: Observer holds the file too
- **WHEN** the observing process has a watch or read handle open on a rollout
- **THEN** it is not reported by `holders` or `heldUnder`, and is never bound as a session pid

#### Scenario: Exec children ignored
- **WHEN** `process_manager/chat_processes.json` lists osPids for shell commands
- **THEN** those pids are not used as session pids and the file is never opened

### Requirement: Active session validation
The provider SHALL accept a live binding only when all of these hold:
- the rollout's first record parses as `session_meta` with a UUID `id`
- the file is under a size bound for that first-line read
- `cwd` is a non-empty string
- `holders(path)` returns at least one pid
- that process exists

The process start time SHALL NOT be compared with `session_meta.timestamp`. The pid comes from a live `holders` probe, so it cannot be a recycled pid, and a resumed thread's `session_meta.timestamp` always predates the process that resumed it. A malformed or oversized first line SHALL produce no session event and SHALL leave the watch running. Candidates that fail validation SHALL be ignored, not guessed.

#### Scenario: Resume of an old thread
- **WHEN** a process started today holds a rollout whose `session_meta.timestamp` is from yesterday
- **THEN** it is accepted

#### Scenario: Holder exited
- **WHEN** the pid returned by `holders` no longer exists when its start time is read
- **THEN** no session event is emitted

#### Scenario: Corrupt first line
- **WHEN** a new rollout's first line is invalid JSON
- **THEN** no event is emitted and the watch keeps running

### Requirement: Create vs open
When an accepted live binding appears, the provider SHALL emit `session:open` if a rollout for that thread id already existed (it would have been listed as history). Otherwise it SHALL emit `session:create`. The decision SHALL NOT be revised later.

#### Scenario: Fresh conversation
- **WHEN** a new root rollout appears whose thread id had no existing file
- **THEN** `session:create` is emitted, and it is not changed to open as records are appended

#### Scenario: Resumed conversation
- **WHEN** a process opens an existing root rollout
- **THEN** `session:open` is emitted

### Requirement: Holders set changes
When a day directory notification or a `heldUnder` probe result arrives, the provider SHALL diff the accepted live roots against the bound set keyed by thread id. An added id SHALL bind; a removed id (file no longer held) SHALL close; a changed `cwd` on the same id SHALL produce `session:update`. A conversation switch is one removal plus one addition: the same pid stops holding thread A and starts holding thread B. Removing a held file SHALL produce `session:close` even if another thread still uses that pid.

Closing a file handle raises no filesystem notification, so a drop is only ever found by a probe. Whenever the provider binds a rollout for pid P, or services a notification for a rollout bound to pid P, it SHALL re-probe `holders` for every other rollout bound to P in that same pass and close those no longer held. A long-lived process (VS Code, app-server) that unloads a thread without exiting and without touching another rollout SHALL stay listed until the next such notification, `reconcile(pid)`, or process exit; this is an accepted limit of observing files, and SHALL NOT be worked around with a timer.

#### Scenario: Conversation switch
- **WHEN** the same pid stops holding rollout A and starts holding rollout B
- **THEN** `session:close(A)` is emitted, then `session:open(B)` or `session:create(B)`, and B does not inherit A's status or title

#### Scenario: Switch is found by the new bind
- **WHEN** pid P is bound to rollout A, then rollout B appears held by P while A is no longer held
- **THEN** binding B re-probes A in the same pass, so `session:close(A)` fires without any notification on A

#### Scenario: Thread unloaded quietly
- **WHEN** a long-lived process drops rollout A and nothing else under `sessions/` changes
- **THEN** A stays live until the next notification for that pid's rollouts, `reconcile(pid)`, or process exit, and no timer runs

#### Scenario: Two sessions one pid
- **WHEN** one process has two root rollouts open
- **THEN** both sessions are bound and live

#### Scenario: Process exits cleanly
- **WHEN** a bound process no longer holds a thread's rollout
- **THEN** `session:close` is emitted with `pid` unset

### Requirement: Process exit without cleanup
The provider SHALL call `watchProcess(pid)` at most once per pid, shared by every bound session with that pid. On the exit event it SHALL emit `session:close` for every bound session of that pid and mark the pid stale, so those rollouts are not re-bound until a holders probe finds a process that passes validation. When `watchProcess` is unsupported, the provider SHALL re-probe holders for every bound rollout while servicing any sessions-directory notification, and on `reconcile(pid)`. It SHALL NOT check pids or holders on a timer. When `heldUnder` / `holders` is not implemented, the provider SHALL emit no live sessions and SHALL still serve history.

#### Scenario: Killed with file left behind
- **WHEN** a bound process is `kill -9`ed and its rollout remains on disk
- **THEN** `session:close` fires from the exit event for each of those sessions, and `running()` no longer lists them

#### Scenario: Stale file reused by a new process
- **WHEN** a new process later opens that rollout and its `session_meta.timestamp` is at or after that process's start minus 5 seconds
- **THEN** it is validated afresh and `session:create` or `session:open` fires

#### Scenario: No holders probe
- **WHEN** the injected `Processes` does not implement `heldUnder` or `holders`
- **THEN** no live Codex session is emitted and `list` still returns historical rollouts

### Requirement: Rollout location
The provider SHALL parse rollout names the way Codex does (`codex-rs/rollout/src/rollout_file_name.rs`): `rollout-<YYYY-MM-DDThh-mm-ss>-<thread-id>.jsonl`, optionally `_<rollout-id>` after the thread id when `thread/revert` created a new immutable file. The thread id is the UUID immediately after the timestamp, not the UUID after `_`. A trailing `.zst` SHALL be stripped before parsing. Live tails SHALL use the file a process currently holds. When several files share a thread id (a revert), history SHALL list one snapshot for that id (the newest file). Archived copies under `archived_sessions/` SHALL NOT be tailed as live.

#### Scenario: Path from filename
- **WHEN** the file is `sessions/2026/09/18/rollout-2026-09-18T12-00-00-01a086af-479c-7832-974c-7490f99f3a9b.jsonl`
- **THEN** the thread id is `01a086af-479c-7832-974c-7490f99f3a9b`

#### Scenario: Revert suffix
- **WHEN** the file is `rollout-2026-09-18T12-00-00-<thread-id>_<rollout-id>.jsonl` and a process holds it
- **THEN** the session id is `<thread-id>`, not `<rollout-id>`, and the older file without the suffix is not a second live session

### Requirement: Rollout relocation
When a bound session's rollout is found at a new path for the same thread id (a move or a date-directory rewrite), the provider SHALL switch its tail to the new location and replay from the start silently, keeping the session open, its status, its title, and every finished subagent finished. A `thread_settings_applied` event whose `thread_settings.cwd` differs SHALL produce `session:update` without closing the session.

#### Scenario: File moved
- **WHEN** a bound rollout is moved to another date directory and is still held by the same pid
- **THEN** `session:update` may fire, no `session:close` fires, later appends are tailed from the new path, and no `subagent:start` fires for subagents already ended

#### Scenario: Revert creates a new file
- **WHEN** `thread/revert` writes `rollout-<ts>-<thread-id>_<rollout-id>.jsonl` and the process holds the new file
- **THEN** the same session stays live, the tail switches to the new path, and no second `session:create` fires for the rollout id

#### Scenario: Cwd change
- **WHEN** `thread_settings_applied` reports a new cwd
- **THEN** `session:update` reports the new `cwd` and the session stays live

### Requirement: Status mapping
The provider SHALL derive `status` only from the turn-lifecycle `event_msg` records Codex persists to the bound root rollout, never from `response_item` text, sqlite, or file mtime:
- `task_started` (alias `turn_started`) → `running`
- `task_complete` (alias `turn_complete`) or `turn_aborted` → `idle`
- when no turn is open → `idle`

Any other `event_msg` type SHALL leave `status` unchanged; in particular `item_completed`, `token_count`, and `thread_settings_applied` SHALL NOT start or end a turn.

Codex's rollout persistence policy (`rollout/src/policy.rs` `should_persist_event_msg`) writes only `task_started`, `task_complete`, `turn_aborted`, `thread_settings_applied`, `token_count`, `thread_goal_updated`, `thread_rolled_back`, and `item_completed` (plus a few legacy-mode message events). Approval and input requests (`exec_approval_request`, `apply_patch_approval_request`, `request_permissions`, `request_user_input`, `elicitation_request`), `error`, every `*_begin` event, `exec_command_end`, `collab_*`, `mcp_startup_*`, and `shutdown_complete` are transient and never reach disk. The provider therefore SHALL NOT report `waiting` or `waitingFor` for a Codex session: a session blocked on an approval SHALL read as `running`. The provider SHALL NOT infer `waiting` from elapsed time since the last record. If a transient type does appear in a rollout, it SHALL be treated as unknown.

#### Scenario: Approval prompt is not observable
- **WHEN** Codex is blocked on an exec approval, so the rollout's last records are `task_started` and a `response_item` tool call with no output
- **THEN** `status` is `running`, `waitingFor` is absent, and no timer is armed to guess otherwise

#### Scenario: Turn over
- **WHEN** the latest `event_msg` is `task_complete`
- **THEN** `status` is `idle`

#### Scenario: Unknown event
- **WHEN** the rollout carries an unknown `event_msg` type after `task_started`
- **THEN** `status` remains `running`

#### Scenario: Response item disagrees
- **WHEN** a `response_item` function call is the last conversation record but `event_msg` has already recorded `task_complete`
- **THEN** `status` is `idle`

### Requirement: History listing
`list` SHALL yield one snapshot per root thread id under `<home>/sessions` (not `archived_sessions`). A `.jsonl.zst` sibling SHALL count as that thread when no plain `.jsonl` exists; the provider SHALL NOT decompress it. If both exist, the plain file wins. Each snapshot SHALL take:
- `cwd` from `session_meta.cwd` when the plain file is read, otherwise absent
- `title` by precedence: newest `session_index.jsonl` `thread_name` for that id (`harness`), else the first real user `response_item` (`prompt`) when the plain file is read
- `startedAt` from `session_meta.timestamp` when read, else the filename timestamp
- `updatedAt` from the last record timestamp, or the file mtime if none
- `model` from the latest `turn_context` / `thread_settings_applied` model, or absent
- `kind` `headless` when `session_meta.source` is `exec` or `mcp`, otherwise `interactive`

Listing SHALL NOT parse the whole rollout except as needed for a missing title. `since` SHALL short-circuit on file mtime before parsing. Subagent rollouts SHALL be excluded. Several files sharing a thread id (revert) SHALL produce one snapshot.

#### Scenario: Subagents excluded
- **WHEN** a parent rollout and three child rollouts with `parent_thread_id` set exist in the same day directory
- **THEN** only the parent is listed

#### Scenario: Model in history
- **WHEN** `thread_settings_applied` names model `gpt-5.6-luna`
- **THEN** the listed snapshot has `model` `gpt-5.6-luna`

#### Scenario: Compressed only
- **WHEN** a root thread exists only as `rollout-…-<id>.jsonl.zst` and `session_index.jsonl` has a `thread_name` for that id
- **THEN** it is listed with that title and without opening the zst file

### Requirement: Record mapping
The provider SHALL map rollout records to normalized events:
- a `response_item` `message` with role `user` and non-empty text that is not only generated markup → `user`
- a `response_item` `message` with role `assistant` and `output_text` → `assistant` with `model` from the latest turn context
- `function_call`, `local_shell_call`, `custom_tool_call` → `tool` with `id` from `call_id` and `name` from `name` (or `local_shell` / `exec`)
- `function_call_output`, `custom_tool_call_output` → `tool-result` with `id` from `call_id`
- `event_msg` `task_complete` / `turn_complete` / `turn_aborted` → `turn-end`
- `event_msg` `task_complete` whose `error` field is set → `error` with that `error.message`, then `turn-end`. A standalone `event_msg` `error` is never persisted and SHALL NOT be relied on
- a child rollout, or an `event_msg` `item_completed` whose `item.type` is `CollabAgentToolCall` with `tool` `spawn_agent` (child ids in `receiver_agents[].thread_id`) → `subagent`
- child completion (the child's own turn end, or a later `CollabAgentToolCall` `agents_states` entry for that child) → `subagent-end`

`item_completed` items that duplicate a `response_item` (`Reasoning`, `AgentMessage`, `UserMessage`, `CommandExecution`, `FileChange`, `McpToolCall`, `ImageView`) SHALL NOT produce a second `user`, `assistant`, `tool`, or `tool-result` event. Which `item_completed` items are present depends on the thread's history mode (`paginated` persists all of them; `legacy` only a few), so the mapper SHALL produce the same conversation from `response_item` records alone.

`session_meta`, `turn_context`, `token_usage_record`, `world_state`, `reasoning`, encrypted content, `compacted` replacement internals, and unknown types SHALL NOT be mapped as `user` prompts. Unknown record types SHALL be unmapped, not errors.

#### Scenario: Reasoning is not a prompt
- **WHEN** a `response_item` has type `reasoning`
- **THEN** no `user` or `assistant` event is produced from it

#### Scenario: Captured real journal
- **WHEN** the captured fixture rollout from Codex CLI is replayed
- **THEN** the produced sequence matches the checked-in expected output

### Requirement: Turn activity from event_msg
For a bound live session, the provider SHALL tail the root rollout and report turn facts as follows:
- `task_started` / `turn_started` starts a turn and clears any standing error
- a `response_item` tool call (`function_call`, `custom_tool_call`, `local_shell_call`, `web_search_call`, `image_generation_call`) starts a tool; `activity.tool.id` is `call_id` when present, otherwise the tool name. The `*_begin` events are never persisted and SHALL NOT be relied on
- the `function_call_output` / `custom_tool_call_output` with the same `call_id` finishes that tool. `item_completed` items (`CommandExecution`, `FileChange`, `McpToolCall`) carry their own `exec-…` ids, not the `call_id` (one `exec` tool call can run several commands), so they SHALL NOT start or finish a tool; a failed command (`exit_code` not 0) does not end the turn
- `task_complete` / `turn_complete` with no `error` ends the turn `completed`
- `task_complete` / `turn_complete` with `error` set ends it `failed` with `activity.error` from `error.message`
- `turn_aborted` ends it `interrupted`, whatever its `reason`

A turn that is still open when the session closes SHALL end `interrupted`. At bind, the provider SHALL replay the rollout to reconstruct activity without emitting intermediate facts; a tool call left open by an earlier turn that has since ended SHALL NOT be reported as the current tool.

#### Scenario: Bound to an idle session mid-tool
- **WHEN** the provider binds to a session whose last turn ended with `turn_aborted` after a `function_call` that has no output
- **THEN** `activity.tool` is absent and `lastTurn` is `interrupted`

#### Scenario: API error turn
- **WHEN** `task_complete` carries `error` with a message
- **THEN** `activity.lastTurn` is `failed` and `activity.error` is that message until the next `task_started`

#### Scenario: Tool reported twice
- **WHEN** a `custom_tool_call` `exec`, two `item_completed` `CommandExecution` records it caused, and its `custom_tool_call_output` are appended
- **THEN** one tool start and one tool finish are reported, keyed by the `call_id`

#### Scenario: Replay at bind is silent
- **WHEN** the provider binds to a session whose rollout holds forty finished turns
- **THEN** one `session:activity` reflecting the final state is emitted, not forty

#### Scenario: Settings are not a turn
- **WHEN** the rollout holds only `session_meta`, `thread_settings_applied`, and `token_count` records
- **THEN** `activity.lastTurn` is absent and `status` is `idle`

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

### Requirement: Headless sessions
`codex exec` sessions (`session_meta.source` `exec`) SHALL be live while a process holds the rollout, then remain in history with `kind` `headless`. A session whose `source` is `mcp` SHALL also be `headless`. `source` `cli` or `vscode` SHALL be `interactive`.

#### Scenario: Print-mode run
- **WHEN** `codex exec` runs and exits
- **THEN** `session:create` (or `open`), status, and `session:close` fire while it is held, and `sessions({ since })` returns it with `kind` `headless`

### Requirement: Watch surface
The provider SHALL hold exactly these watches while running: one on `<home>/sessions` and on each year, month, and day directory discovered under it (including those created later), one `tailJsonl` on each bound root rollout, one `tailJsonl` on each running subagent rollout, one `watchFile`/`tailJsonl` on `<home>/session_index.jsonl` when that file is used for titles, and one `watchProcess` per bound pid. It SHALL NOT watch `<home>` recursively for `auth.json`, sqlite, or `ipc`. Every watch SHALL use the shared helpers' debounce and latency ceiling.

#### Scenario: Busy session
- **WHEN** a bound session's rollout receives 30 appends a second
- **THEN** it is read about once a second and every appended line is eventually yielded in order

### Requirement: Missing Codex home
If `<home>` or `<home>/sessions` does not exist at start, the provider SHALL watch the nearest existing ancestor and begin observing once the directory is created, without polling.

#### Scenario: Codex installed after start
- **WHEN** the provider starts with no `~/.codex`, and then a live process creates `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` and holds it
- **THEN** a session event is emitted for it

### Requirement: Model from turn context
For a bound live session, the provider SHALL report `model` from `thread_settings_applied` (`thread_settings.model`) or `turn_context` (`model`), whichever is latest; `task_started` carries no model: the model at bind, and each change after that. Subagent rollouts SHALL NOT change the root session's `model`.

#### Scenario: Model known at bind
- **WHEN** a session binds to a rollout whose latest `thread_settings_applied` names `gpt-5.6-luna`
- **THEN** the session has `model` `gpt-5.6-luna` by the time `ready` fires

#### Scenario: Model switched mid-session
- **WHEN** a live session's next `thread_settings_applied` names a different model
- **THEN** `session:update` fires with the new `model`

### Requirement: Journal read once at bind
Binding a live session to an existing rollout SHALL read that file's bytes once, apart from the one bounded read of its head that validates it. The records already in the file SHALL seed titles, model, subagents, and activity without producing live turn or subagent-start events, and only records appended afterwards SHALL be handled as live.

#### Scenario: Large journal
- **WHEN** a session binds to a rollout that already holds records
- **THEN** beyond the bounded validation read, each byte of the file present at bind is read once, and a record appended afterwards is handled exactly once

### Requirement: Record failures are reported, not fatal
A failure while handling one rollout record SHALL be reported through `ctx.reportError` and that record skipped. The rollout tail and the session's other watches SHALL keep running.

#### Scenario: Handling fails for one record
- **WHEN** handling one appended record fails and a tool-call record is appended after it
- **THEN** `error` is emitted for provider `codex-cli` and the session's `activity.tool` still reflects the later record

### Requirement: Date-directory events are serviced in order
Events for one date directory SHALL be serviced one at a time, in the order they were reported. A later event for that directory (a new rollout or a removal) SHALL NOT overtake a bind that is still in progress. A session that is closed, or a provider that is unwatched, while work for it is awaiting the filesystem SHALL NOT have a rollout tail or process watch attached afterwards.

#### Scenario: File removed while binding
- **WHEN** a rollout is deleted while that session is still being bound
- **THEN** `session:open` or `session:create` is followed by `session:close`, the session is not live afterwards, and only the date-tree watches are still watched

#### Scenario: Process exits while the journal is being read
- **WHEN** a session's process exits while its rollout backlog is still being read
- **THEN** `session:close` fires and no watch for that session is open once the read finishes

#### Scenario: Stopped while binding
- **WHEN** the instance is stopped while a session is being bound
- **THEN** no event is emitted for that session and no watch is left open

### Requirement: Prompt title for live sessions
For a bound live session the provider SHALL report the first real user `response_item` as a title with source `prompt`, truncated as in History listing, so a live session and the same session in history have the same title. A later `session_index.jsonl` `thread_name` for that id SHALL be reported as source `harness` and SHALL take precedence over `prompt`. Reasoning, encrypted content, and environment/developer wrappers SHALL NOT be mapped as `user` prompts, start a turn, or title a session.

#### Scenario: Live session with no generated title
- **WHEN** a session binds to a rollout holding a user prompt and `session_index.jsonl` has no `thread_name` for it
- **THEN** the session's `title` is that prompt

#### Scenario: Generated title wins
- **WHEN** `session_index.jsonl` later records `thread_name` `Create explorable 3D house garden` for that id
- **THEN** `title` becomes that string with source `harness`
