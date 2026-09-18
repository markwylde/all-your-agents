# grok-build-provider Specification

## Purpose

Observes Grok Build CLI sessions from the files Grok itself writes, and exposes them through the harness-neutral session API as a second built-in provider beside Claude Code.

## Requirements

### Requirement: Built in by default, isolated in code
The Grok Build provider SHALL be included in `builtInProviders` and SHALL also be importable on its own. The provider id SHALL be `grok-build` and the harness SHALL be `Grok`. Its Grok home SHALL default to `$GROK_HOME` when set, otherwise `~/.grok`, and SHALL be configurable, so tests can point it at a temporary directory.

#### Scenario: Custom home
- **WHEN** the provider is created with a home pointing at a fixture directory
- **THEN** it reads only beneath that directory

#### Scenario: Home from the environment
- **WHEN** `GROK_HOME` is set and no home is passed
- **THEN** the provider reads beneath that directory

### Requirement: Live index from active_sessions.json
The provider SHALL treat `<home>/active_sessions.json` as the only live index. It SHALL read only these fields from each array entry:
- `session_id`
- `pid`
- `cwd`
- `opened_at`

It SHALL NOT open `active_sessions.lock`, `active_sessions.json.tmp`, `auth.json`, `sessions/session_search.sqlite`, or any `*.lock` sibling. It SHALL NOT use journal mtime, "newest session dir", or open file handles to decide which process holds which session.

#### Scenario: Lock and tmp ignored
- **WHEN** `active_sessions.lock` and `active_sessions.json.tmp` exist beside the index
- **THEN** the provider never opens them

#### Scenario: Two sessions in one directory
- **WHEN** two live processes with the same cwd each have an index entry naming different session ids
- **THEN** each process is bound to its own session id

### Requirement: Active session validation
The provider SHALL accept an index entry only when all of these hold:
- the JSON parses as an array
- the file is under a size bound
- `session_id` is a UUID
- `pid` is a positive integer
- `cwd` is a non-empty string
- the process with that pid exists
- `opened_at` is at or after that process's start time minus 5 seconds

`opened_at` is the registration time (`Utc::now()` on each load, resume, or new session), not the process start. There is no upper bound relative to start: a session opened a minute after launch SHALL be accepted. If the start time cannot be determined but the process exists, the entry SHALL be accepted. A malformed or oversized file SHALL produce no session events and SHALL leave the watch running. Entries that fail validation SHALL be ignored, not guessed.

#### Scenario: Recycled pid
- **WHEN** an index entry left by a crashed process names a pid now used by a process that started hours later
- **THEN** no session event is emitted

#### Scenario: Resume long after launch
- **WHEN** `opened_at` is 60 seconds after the process start time
- **THEN** it is accepted

#### Scenario: Clock skew within tolerance
- **WHEN** `opened_at` is 4 seconds before the process start time
- **THEN** it is accepted

#### Scenario: Opened before the process
- **WHEN** `opened_at` is 6 seconds before the process start time
- **THEN** it is rejected

#### Scenario: Corrupt index
- **WHEN** `active_sessions.json` contains invalid JSON
- **THEN** no event is emitted and the watch keeps running

### Requirement: Create vs open
When an accepted index entry appears, the provider SHALL emit `session:open` if a session directory for that `session_id` already exists. Otherwise it SHALL emit `session:create`. The decision SHALL NOT be revised later.

#### Scenario: Fresh conversation
- **WHEN** an index entry appears whose session id has no session directory
- **THEN** `session:create` is emitted, and it is not changed to open when the directory appears

#### Scenario: Resumed conversation
- **WHEN** an index entry appears whose session id already has a session directory
- **THEN** `session:open` is emitted

### Requirement: Index rewrites and removal
When `active_sessions.json` is rewritten, the provider SHALL diff the accepted entries against the bound set keyed by `session_id`. One pid MAY appear on several entries (the TUI dashboard registers one row per agent). An added id SHALL bind; a removed id SHALL close; a changed `cwd` on the same id SHALL produce `session:update`. A conversation switch is one removal plus one addition, not "the pid's session_id changed". Removing an entry SHALL produce `session:close` even if another entry still uses that pid.

#### Scenario: Conversation switch
- **WHEN** the index drops session A and adds session B for the same pid
- **THEN** `session:close(A)` is emitted, then `session:open(B)` or `session:create(B)`, and B does not inherit A's status or title

#### Scenario: Two sessions one pid
- **WHEN** the index holds two entries with the same pid and different session ids
- **THEN** both sessions are bound and live

#### Scenario: Process exits cleanly
- **WHEN** the index no longer contains a bound session id
- **THEN** `session:close` is emitted with `pid` unset

### Requirement: Process exit without cleanup
The provider SHALL call `watchProcess(pid)` at most once per pid, shared by every bound session with that pid. On the exit event it SHALL emit `session:close` for every bound session of that pid and mark the pid stale, so those entries are not re-bound until the index is rewritten by a process that passes validation. When `watchProcess` is unsupported, the provider SHALL re-validate every bound pid with `processInfo` while servicing any `active_sessions.json` notification, and on `reconcile(pid)`. It SHALL NOT check pids on a timer.

#### Scenario: Killed with entry left behind
- **WHEN** a bound process is `kill -9`ed and its index entries remain
- **THEN** `session:close` fires from the exit event for each of those sessions, and `running()` no longer lists them

#### Scenario: Stale entry reused by a new process
- **WHEN** a stale entry is later rewritten by a new process with that pid whose `opened_at` is at or after that process's start minus 5 seconds
- **THEN** it is validated afresh and `session:create` or `session:open` fires

### Requirement: Session directory location
The provider SHALL find a session at `<home>/sessions/<encoded-cwd>/<session_id>/`, where `encoded-cwd` percent-encodes every character except `A-Z` `a-z` `0-9` `-` `_` `.` `~` (Rust `urlencoding::encode` / RFC 3986 unreserved). This is not `encodeURIComponent`, which leaves `!'()*` unencoded. When that encoding is at most 255 bytes it is the directory name. When it would exceed 255 bytes, the directory name SHALL be `{slug}-{blake3-hex16}` and the original cwd SHALL be recovered from a `.cwd` file inside that directory. If the derived path is missing, the provider SHALL perform one bounded lookup for exactly `<session_id>/` across the session cwd directories. If more than one directory holds that id, it SHALL report no session directory rather than choose one.

#### Scenario: Encoding
- **WHEN** the cwd is `/Users/me/app`
- **THEN** the session cwd directory is `%2FUsers%2Fme%2Fapp`

#### Scenario: Characters encodeURIComponent leaves
- **WHEN** the cwd is `/tmp/foo(bar)!`
- **THEN** the session cwd directory is `%2Ftmp%2Ffoo%28bar%29%21`

#### Scenario: Long cwd
- **WHEN** the URL-encoded cwd exceeds 255 bytes
- **THEN** the directory name is the slug-hash form and `.cwd` holds the original path

#### Scenario: Ambiguous id
- **WHEN** two cwd directories each contain `<session_id>/`
- **THEN** no session directory is bound

### Requirement: Session directory relocation
When a bound session's index entry reports a new `cwd` for the same `session_id`, the provider SHALL resolve the session directory again. If it is now at a different path, it SHALL switch its tails and its `subagents/` watch to the new location and replay from the start silently, keeping the session open, its status, its title, and every finished subagent finished.

#### Scenario: Worktree move
- **WHEN** a session in `/app` moves to `/app/.grok/worktrees/x` and its directory moves to the new encoded cwd
- **THEN** `session:update` reports the new `cwd`, no `session:close` fires, later appends are tailed from the new path, and no `subagent:start` fires for subagents already ended

#### Scenario: Directory not yet moved
- **WHEN** the index reports a new `cwd` but the session directory is still at the old path
- **THEN** the old tails continue and the next `active_sessions.json` or session-directory event triggers the lookup again

### Requirement: Status mapping
The provider SHALL derive `status` only from the bound session's `events.jsonl` phase and turn records, never from `chat_history.jsonl` or file mtime:
- `waiting_for_model`, `streaming_text`, `streaming_reasoning`, `tool_execution` → `running`
- `permission_prompt` → `waiting`, with `waitingFor` set from the latest `permission_requested` tool name
- after `turn_ended`, or when no turn is open → `idle`

Any other phase word SHALL leave `status` absent. MCP setup events (`mcp_*`) SHALL NOT start a turn or set `running`.

#### Scenario: Permission prompt
- **WHEN** the latest phase is `permission_prompt` and the latest `permission_requested` names `run_terminal_command`
- **THEN** `status` is `waiting` and `waitingFor` is `run_terminal_command`

#### Scenario: Turn over
- **WHEN** the latest event is `turn_ended`
- **THEN** `status` is `idle`

#### Scenario: Unknown phase
- **WHEN** `events.jsonl` carries an unknown phase word
- **THEN** `status` is absent

#### Scenario: Chat history disagrees
- **WHEN** `chat_history.jsonl` ends on an assistant `tool_calls` record but `events.jsonl` has already recorded `turn_ended`
- **THEN** `status` is `idle`

### Requirement: History listing
`list` SHALL yield one snapshot per root session directory under `<home>/sessions` that has a `summary.json` whose `session_kind` is not `subagent` or `subagent_fork`. Each snapshot SHALL take:
- `cwd` from `summary.info.cwd`
- `title` by precedence: `generated_title` when `title_is_manual` is true (`user`), else `generated_title` (`harness`), else the first real user prompt (`prompt`)
- `startedAt` from `created_at`
- `updatedAt` from `last_active_at` or `updated_at`, or the summary file mtime if neither is present
- `model` from `current_model_id`, or absent
- `kind` `headless` when `session_kind` is `headless`, otherwise `interactive`

Listing SHALL NOT parse `chat_history.jsonl` except as needed for a missing title. `since` SHALL short-circuit on file mtime before parsing.

#### Scenario: Subagents excluded
- **WHEN** a parent session has `subagents/<id>/` and a child session directory with `session_kind` `subagent`
- **THEN** only the parent is listed

#### Scenario: Model in history
- **WHEN** a summary's `current_model_id` is `grok-4.6`
- **THEN** the listed snapshot has `model` `grok-4.6`

### Requirement: Chat history record mapping
The provider SHALL map `chat_history.jsonl` records to normalized events:
- a `user` record with `prompt_index` and text that is not only an injected reminder → `user`
- an `assistant` record's text → `assistant` with `model` from `model_id`
- each assistant `tool_calls` entry → `tool` with `id` and `name`
- a `tool_result` → `tool-result` with `id` from `tool_call_id`
- a `spawn_subagent` tool use → `subagent`
- a subagent completion (see Subagent lifecycle) → `subagent-end`
- an assistant record that is only an error payload → `error`

Injected system reminders (`synthetic_reason` `system_reminder`, or text that is only a `<system-reminder>` block), `reasoning` records, `system` records, and `tool_definitions` SHALL NOT be mapped as `user` prompts. Unknown record types SHALL be unmapped, not errors. Duplicate consecutive `user` records with the same `prompt_index` SHALL produce one `user` event.

#### Scenario: System reminder is not a prompt
- **WHEN** a user record has `synthetic_reason` `system_reminder`
- **THEN** no `user` event is produced

#### Scenario: Captured real journal
- **WHEN** the captured fixture `chat_history.jsonl` from Grok Build is replayed
- **THEN** the produced sequence matches the checked-in expected output

### Requirement: Turn activity from events.jsonl
For a bound live session, the provider SHALL tail `events.jsonl` and report turn facts as follows:
- `turn_started` starts a turn and clears any standing error
- `tool_started` starts a tool named `tool_name`; `activity.tool.id` is `tool_name` until `tool_completed` supplies `tool_call_id`
- `tool_completed` finishes that tool; `outcome` `error` does not by itself end the turn
- `turn_ended` with `outcome` `completed` ends the turn `completed`; `error` ends it `failed`; `cancelled` ends it `interrupted`. `turn_ended` has no message field. `activity.error` SHALL be taken from a matching `chat_history.jsonl` error/assistant-error record when one exists, and SHALL otherwise be absent

When the derived status becomes `idle` and the turn has not ended, the provider SHALL end it `interrupted` if a tool is still open, and `completed` otherwise. At bind, it SHALL replay `events.jsonl` to reconstruct activity without emitting intermediate facts.

#### Scenario: Bound to an idle session mid-tool
- **WHEN** the provider binds to a session whose last `turn_ended` is older than a later `tool_started` with no matching `tool_completed`
- **THEN** `activity.tool` is absent and `lastTurn` is `interrupted`

#### Scenario: API error turn
- **WHEN** `turn_ended` has `outcome` `error` and `chat_history.jsonl` has no error text for that turn
- **THEN** `activity.lastTurn` is `failed` and `activity.error` is absent until the next `turn_started`

#### Scenario: Failed turn with chat-history error
- **WHEN** `turn_ended` has `outcome` `error` and a matching chat-history record carries error text
- **THEN** `activity.lastTurn` is `failed` and `activity.error` is that text until the next `turn_started`

#### Scenario: Replay at bind is silent
- **WHEN** the provider binds to a session whose `events.jsonl` holds forty finished turns
- **THEN** one `session:activity` reflecting the final state is emitted, not forty

#### Scenario: MCP init is not a turn
- **WHEN** `events.jsonl` holds only `mcp_*` records
- **THEN** `activity.lastTurn` is absent and `status` is `idle`

### Requirement: Subagent lifecycle
The provider SHALL discover a subagent from either of two sources, whichever comes first:
- a `spawn_subagent` tool use in `chat_history.jsonl`
- a `<sessionId>/subagents/<subagent_id>/meta.json` file

It SHALL link them by `subagent_id` / `child_session_id`. Subagent fields come from these sources:
- `id` from `subagent_id`
- `type` from `subagent_type`
- `title` from `description`
- `background` from the spawn arguments' `background` being true, or the tool result saying the subagent started in the background
- `parentId` from the journal that contains the launching `spawn_subagent`: absent for the root, otherwise that subagent's id

Completion SHALL be recorded as follows:
- `meta.json` `status` `completed` → `completed`; `failed`/`error` → `failed`; `cancelled`/`killed`/`interrupted` → `cancelled`
- a `meta.json` with no `completed_at` is `running`
- `output.json` appearing without a final status SHALL end it `completed`

When the parent session's derived status becomes `idle`, open foreground subagents SHALL end `cancelled`, and background ones SHALL stay open. The provider SHALL watch the `subagents/` directory of each live session so a subagent is seen as soon as `meta.json` appears. The live index has no `session_kind`. At bind the provider SHALL do one bounded read of that session's `summary.json`; if `session_kind` is `subagent` or `subagent_fork`, it SHALL NOT emit `session:create` or `session:open` for it, and SHALL attach it to the parent when the parent is bound. Grok is not observed to register subagents in the index; this is fail-closed if it ever does.

#### Scenario: Foreground general-purpose agent
- **WHEN** the root `chat_history.jsonl` records a `spawn_subagent` with `subagent_type` `general-purpose` and no `background`, and later `meta.json` status `completed`
- **THEN** `subagent:start` fires with `type` `general-purpose` and `background` false, then `subagent:end` with `completed`

#### Scenario: Background agent
- **WHEN** a background spawn's tool result says it was started in the background, the parent goes `idle`, and later `meta.json` status becomes `completed`
- **THEN** the subagent stays `running` through the idle, then ends `completed`

#### Scenario: Meta file before the tool use is tailed
- **WHEN** `subagents/<id>/meta.json` appears before the root journal's `spawn_subagent` record is read
- **THEN** exactly one `subagent:start` fires once the two are linked, not two

#### Scenario: Resumed session with prior subagents
- **WHEN** the provider binds to a resumed session whose `subagents/` directory contains five finished meta files
- **THEN** `subagents()` returns five ended subagents and no `subagent:start` is emitted for them

#### Scenario: Subagent transcript
- **WHEN** `transcript()` is called on a subagent
- **THEN** it replays that child's `chat_history.jsonl`, and its records do not affect the root session's activity

#### Scenario: Live index entry for a subagent
- **WHEN** `active_sessions.json` contains a child whose `summary.json` has `session_kind` `subagent` and its parent is bound
- **THEN** no `session:create` or `session:open` fires for the child, and `subagent:start` fires on the parent if the child is still running

### Requirement: Headless sessions
Sessions without an `active_sessions.json` entry (for example `grok -p` without `GROK_TRACK_HEADLESS`) SHALL appear only in history, with `kind` `headless` when `summary.session_kind` is `headless`. The provider SHALL NOT infer liveness for sessions without an index entry. When `GROK_TRACK_HEADLESS` causes headless runs to register in the index, those entries SHALL be accepted if they pass validation, with `kind` `headless`.

#### Scenario: Print-mode run
- **WHEN** `grok -p` runs and leaves a session directory but no index entry
- **THEN** no live event fires, and `sessions({ since })` returns it with `kind` `headless`

### Requirement: Watch surface
The provider SHALL hold exactly these watches while running: one on `<home>/active_sessions.json` via `watchFile` (or the nearest existing ancestor until that file exists), one on each bound root `events.jsonl`, one on each bound root `chat_history.jsonl`, one on each bound `summary.json`, one on each bound session's `subagents/` directory, one on each running subagent `meta.json` (and the child's `chat_history.jsonl` while its transcript is followed), and one `watchProcess` per distinct pid (shared when several sessions share a pid). It SHALL NOT watch `<home>/sessions` recursively. File watches that target tmp-then-rename files (`active_sessions.json`, `summary.json`, `meta.json`) SHALL use `watchFile`, which watches the parent directory filtered by filename. Every watch SHALL use the shared helpers' debounce and latency ceiling.

#### Scenario: Busy session
- **WHEN** a bound session's `events.jsonl` receives 30 appends a second
- **THEN** it is read about once a second and every appended line is eventually yielded in order

### Requirement: Missing Grok home
If `<home>` or `<home>/active_sessions.json` does not exist at start, the provider SHALL watch the nearest existing ancestor and begin observing once the file is created, without polling.

#### Scenario: Grok installed after start
- **WHEN** the provider starts with no `~/.grok`, and then `~/.grok/active_sessions.json` is created with a live process entry
- **THEN** a session event is emitted for it

### Requirement: Model from summary and events
For a bound live session, the provider SHALL report `model` from `summary.json` `current_model_id` at bind, then from each later `turn_started.model_id` or assistant `model_id` that names a real model. Subagent journals SHALL NOT change the root session's `model`.

#### Scenario: Model known at bind
- **WHEN** a session binds to a summary whose `current_model_id` is `grok-4.6`
- **THEN** the session has `model` `grok-4.6` by the time `ready` fires

#### Scenario: Model switched mid-session
- **WHEN** a live session's next `turn_started` names a different `model_id`
- **THEN** `session:update` fires with the new `model`

### Requirement: Session files read once at bind
Binding a live session to an existing `events.jsonl` and `chat_history.jsonl` SHALL read each file's bytes once, apart from the bounded reads that locate and validate the session directory. Records already in the files SHALL seed titles, model, subagents, and activity without producing live turn or subagent-start events, and only records appended afterwards SHALL be handled as live.

#### Scenario: Large journal
- **WHEN** a session binds to an `events.jsonl` that already holds records
- **THEN** beyond the bounded validation read, each byte of that file present at bind is read once, and a record appended afterwards is handled exactly once

### Requirement: Record failures are reported, not fatal
A failure while handling one `events.jsonl` or `chat_history.jsonl` record SHALL be reported through `ctx.reportError` and that record skipped. The tails and the session's other watches SHALL keep running.

#### Scenario: Handling fails for one record
- **WHEN** handling one appended event record fails and a `tool_started` record is appended after it
- **THEN** `error` is emitted for provider `grok-build` and the session's `activity.tool` still reflects the later record

### Requirement: Index events are serviced in order
Events for `active_sessions.json` SHALL be serviced one at a time, in the order they were reported. A later rewrite SHALL NOT overtake a bind that is still in progress. A session that is closed, or a provider that is unwatched, while work for it is awaiting the filesystem SHALL NOT have a journal, subagents directory, or process watch attached afterwards.

#### Scenario: Entry removed while binding
- **WHEN** an index entry is removed while that session is still being bound
- **THEN** `session:open` or `session:create` is followed by `session:close`, the session is not live afterwards, and only the index file is still watched

#### Scenario: Process exits while events are being read
- **WHEN** a session's process exits while its `events.jsonl` backlog is still being read
- **THEN** `session:close` fires and no watch for that session is open once the read finishes

#### Scenario: Stopped while binding
- **WHEN** the instance is stopped while a session is being bound
- **THEN** no event is emitted for that session and no watch is left open

### Requirement: Prompt title for live sessions
For a bound live session the provider SHALL report the first real user prompt in `chat_history.jsonl` as a title with source `prompt`, truncated to 200 characters, so a live session and the same session in history have the same title. A record whose text is wrapped in `<user_query>` SHALL use the inner text. Injected reminders SHALL NOT title a session.

#### Scenario: Live session with no generated title
- **WHEN** a session binds to a journal holding a user prompt and its summary has no `generated_title`
- **THEN** the session's `title` is that prompt

#### Scenario: Manual rename wins
- **WHEN** `summary.json` has `title_is_manual` true and `generated_title` `Mine`
- **THEN** the title source is `user` and `title` is `Mine`
