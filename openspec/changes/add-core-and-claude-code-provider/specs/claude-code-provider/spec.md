## Purpose

Observes Claude Code CLI sessions from the files Claude Code itself writes, and exposes them through the harness-neutral session API as the built-in reference provider.

## ADDED Requirements

### Requirement: Built in by default, isolated in code
The Claude Code provider SHALL be included in `builtInProviders` and SHALL also be importable on its own. The provider id SHALL be `claude-code` and the harness SHALL be `ClaudeCode`. Its Claude home SHALL default to `$CLAUDE_CONFIG_DIR` when set, otherwise `~/.claude`, and SHALL be configurable, so tests can point it at a temporary directory.

#### Scenario: Custom home
- **WHEN** the provider is created with a home pointing at a fixture directory
- **THEN** it reads only beneath that directory

#### Scenario: Config dir from the environment
- **WHEN** `CLAUDE_CONFIG_DIR` is set and no home is passed
- **THEN** the provider reads beneath that directory

### Requirement: Live index from session files
The provider SHALL treat `<home>/sessions/<pid>.json` as the only live index. It SHALL read only these fields:
- `pid`
- `sessionId`
- `cwd`
- `startedAt`
- `version`
- `status`
- `statusUpdatedAt`
- `waitingFor`
- `name`
- `updatedAt`
- `kind`
- `entrypoint`

It SHALL NOT open `.key` siblings or the messaging socket. It SHALL NOT use journal mtime, "newest journal", or open file handles to decide which process holds which session.

#### Scenario: Key sibling ignored
- **WHEN** `<pid>.<digest>.key` exists beside `<pid>.json`
- **THEN** the provider never opens it

#### Scenario: Two sessions in one directory
- **WHEN** two live processes with the same cwd each have a session file naming different session ids
- **THEN** each process is bound to its own session id, whichever journal was written last

### Requirement: Session file validation
The provider SHALL accept a session file only when all of these hold:
- the JSON parses
- the file is under a size bound
- `pid` equals the filename's pid
- `sessionId` is a UUID
- the process with that pid exists
- `startedAt` is within 5 seconds of that process's start time

If the start time cannot be determined but the process exists, the file SHALL be accepted.

#### Scenario: Recycled pid
- **WHEN** a session file left by a crashed process names a pid now used by a process that started hours later
- **THEN** no session event is emitted

#### Scenario: Pid mismatch
- **WHEN** `123.json` contains `"pid": 456`
- **THEN** it is rejected

#### Scenario: Within tolerance
- **WHEN** `startedAt` is 4 seconds from the process start time
- **THEN** it is accepted

#### Scenario: Outside tolerance
- **WHEN** `startedAt` is 6 seconds from the process start time
- **THEN** it is rejected

### Requirement: Create vs open
When an accepted session file appears, the provider SHALL emit `session:open` if a journal for that `sessionId` already exists. Otherwise it SHALL emit `session:create`. The decision SHALL NOT be revised later.

#### Scenario: Fresh conversation
- **WHEN** a session file appears whose session id has no journal
- **THEN** `session:create` is emitted, and it is not changed to open when the journal appears

#### Scenario: Resumed conversation
- **WHEN** a session file appears whose session id already has a journal
- **THEN** `session:open` is emitted

### Requirement: Rewrites and removal
When a session file is rewritten with a different `sessionId`, the provider SHALL emit `session:close` for the old id, then `session:open` or `session:create` for the new id. A rewritten `status` SHALL produce `session:status`. A changed `cwd` SHALL produce `session:update`. The file's `name` SHALL be supplied to the core as the process-name title source and produce `session:update` only when it becomes the effective title under title precedence. Removing the session file SHALL produce `session:close`. A status change and a cwd change written together SHALL both be reported.

#### Scenario: Conversation switch
- **WHEN** a live process's session file changes `sessionId` from A to B
- **THEN** `session:close(A)` is emitted, then `session:open(B)`, and B does not inherit A's status or title

#### Scenario: Process exits
- **WHEN** a session file is deleted
- **THEN** `session:close` is emitted with `pid` unset

#### Scenario: Status and cwd in one write
- **WHEN** one rewrite changes both `status` and `cwd`
- **THEN** both `session:status` and `session:update` are emitted

### Requirement: Process exit without cleanup
The provider SHALL call `watchProcess(pid)` when it binds a session file. On the exit event it SHALL emit `session:close` and mark the file stale, so the file is not re-bound until it is rewritten by a process that passes validation. When `watchProcess` is unsupported, the provider SHALL re-validate every bound pid with `processInfo` while servicing any `sessions/` directory event, and on `reconcile(pid)`. It SHALL NOT check pids on a timer.

#### Scenario: Killed with file left behind
- **WHEN** a bound process is `kill -9`ed and `<pid>.json` remains
- **THEN** `session:close` fires from the exit event, and `running()` no longer lists it

#### Scenario: Stale file reused by a new process
- **WHEN** a stale `<pid>.json` is later rewritten by a new process with that pid whose `startedAt` matches
- **THEN** it is validated afresh and `session:create` or `session:open` fires

### Requirement: Journal relocation
When a bound session's file reports a new `cwd` for the same `sessionId`, the provider SHALL resolve the journal again (derived path, then bounded lookup). If the journal is now at a different path, it SHALL switch its tail and its `subagents/` watch to the new location and replay from the start silently, keeping the session open, its status, its title, and every finished subagent finished. Claude Code writes a `relocated` record with `relocatedCwd` at this point; the provider MAY use it to confirm the new path but SHALL NOT depend on it.

#### Scenario: Worktree move
- **WHEN** a session in `/app` enters `/app/.claude/worktrees/x` and its journal moves to `-app--claude-worktrees-x/`
- **THEN** `session:update` reports the new `cwd`, no `session:close` fires, later appends are tailed from the new path, and no `subagent:start` fires for subagents already ended

#### Scenario: Journal not yet moved
- **WHEN** the file reports a new `cwd` but the journal is still at the old path
- **THEN** the old tail continues and the next `sessions/` or `projects/` event triggers the lookup again

### Requirement: Status mapping
The provider SHALL map Claude Code status words as follows:
- `busy` → `running`
- `waiting` → `waiting`, with `waitingFor` copied
- `idle` and `shell` → `idle`

Any other word SHALL leave `status` absent. Status SHALL come only from the session file, never from journal content.

#### Scenario: Journal disagrees with file
- **WHEN** the session file says `idle` while the last journal record is an unfinished assistant turn
- **THEN** `status` is `idle`

#### Scenario: Unknown word
- **WHEN** the session file carries an unknown status word
- **THEN** `status` is absent

### Requirement: Journal location
The provider SHALL find a session's journal at `<home>/projects/<encoded-cwd>/<sessionId>.jsonl`, where every non-alphanumeric character of the cwd is replaced by `-`. If that path is missing, it SHALL perform one bounded lookup for exactly `<sessionId>.jsonl` across the project directories. If more than one directory holds that id, it SHALL report no journal rather than choose one. A journal SHALL only be accepted when its records name the same `sessionId` and are not sidechain records.

#### Scenario: Encoding
- **WHEN** the cwd is `/Users/me/app/.claude/worktrees/x`
- **THEN** the project directory is `-Users-me-app--claude-worktrees-x`

#### Scenario: Resumed from another directory
- **WHEN** a conversation started in `/a` is resumed from `/b`
- **THEN** the journal under `-a` is found by the bounded lookup

#### Scenario: Ambiguous id
- **WHEN** two project directories each contain `<sessionId>.jsonl`
- **THEN** no journal is bound

### Requirement: History listing
`list` SHALL yield one snapshot per root journal under `<home>/projects`. Subagent journals under `<sessionId>/subagents/` SHALL NOT be listed as roots. Each snapshot SHALL take:
- `cwd` from journal records
- `title` by precedence: the latest `custom-title` (`user`), then the latest `ai-title` (`harness`), then the first real user prompt (`prompt`)
- `startedAt` from the first record's timestamp
- `updatedAt` from the last record's timestamp, or the file mtime if no record has one

Listing SHALL read only as much of each journal as those fields need.

#### Scenario: Subagents excluded
- **WHEN** a session has `subagents/agent-*.jsonl` files
- **THEN** only the root session is listed

### Requirement: Journal record mapping
The provider SHALL map journal records to normalized events:
- a non-meta user record with text → `user`
- a user record with `tool_result` → `tool-result`
- assistant text → `assistant` with `model`
- assistant `tool_use` → `tool`
- an `Agent`/`Task` tool use → `subagent`
- a subagent completion (see Subagent lifecycle) → `subagent-end`
- `ai-title` → `title` with source `harness`; `custom-title` → `title` with source `user`
- `system` with subtype `turn_duration` → `turn-end`
- `system` with subtype `agents_killed` → `subagent-end` with `cancelled` for every open subagent
- an assistant record with `isApiErrorMessage: true` → `error`

Injected system reminders, command metadata, and task notifications SHALL NOT be mapped as `user` prompts. `queue-operation` records, whose `content` may hold task-notification text, SHALL be unmapped. Bookkeeping records (`file-history-snapshot`, `file-history-delta`, `attachment`, `permission-mode`, `mode`, `atis-latch`, `bridge-session`, `worktree-state`, `relocated`, `last-prompt`, `system/compact_boundary`, `system/stop_hook_summary`, `system/away_summary`, and similar) SHALL be unmapped. Unknown record types SHALL be unmapped, not errors.

#### Scenario: System reminder is not a prompt
- **WHEN** a user record contains only an injected system reminder
- **THEN** no `user` event is produced

#### Scenario: Queued notification is not a prompt
- **WHEN** a `queue-operation` record's `content` contains `<task-notification>`
- **THEN** no `user` event is produced and no subagent ends

#### Scenario: Agents killed
- **WHEN** a `system/agents_killed` record arrives while two subagents are open
- **THEN** both end `cancelled`

#### Scenario: Captured real journal
- **WHEN** the captured fixture journal from Claude Code 2.1.x is replayed
- **THEN** the produced sequence matches the checked-in expected output

### Requirement: Turn activity from the journal
For a bound live session, the provider SHALL tail its root journal and report turn facts as follows:
- A non-meta user prompt starts a turn and clears any standing error.
- Assistant `tool_use` starts a tool.
- A user `tool_result` with that `tool_use_id` finishes it.
- `system/turn_duration` or an assistant `stop_reason` of `end_turn` ends the turn `completed`.
- An assistant record with `isApiErrorMessage: true` ends it `failed` with its text as the message.
- A user record whose text begins `[Request interrupted by user` ends it `interrupted`.

When the session file changes to `idle` or `shell` and the turn has not ended, the provider SHALL end it `interrupted` if a tool is still open, and `completed` otherwise. At bind, it SHALL replay the journal to reconstruct activity without emitting intermediate facts. During that replay, and after a relocation replay, a record whose timestamp is at or before the session file's `statusUpdatedAt` for an `idle`/`shell` status SHALL NOT leave a tool or turn open: it contributes `lastTurn`, `error`, and subagent history only.

#### Scenario: Bound to an idle session mid-tool
- **WHEN** the provider binds to a session whose file says `idle` and whose journal ends with a `tool_use` older than `statusUpdatedAt`
- **THEN** `activity.tool` is absent and `lastTurn` is `interrupted`

#### Scenario: Turn with no turn_duration
- **WHEN** a turn's records end without `turn_duration` and the session file goes `busy` → `idle`
- **THEN** `lastTurn` is `completed`

#### Scenario: API error record
- **WHEN** the journal records an API error and then the session file goes `idle`
- **THEN** `lastTurn` is `failed` with `error` set

#### Scenario: Replay at bind is silent
- **WHEN** the provider binds to a session whose journal holds forty finished turns
- **THEN** one `session:activity` reflecting the final state is emitted, not forty

#### Scenario: Task notification is not a prompt
- **WHEN** a user record with origin `task-notification` arrives
- **THEN** no turn is started and no error is cleared

### Requirement: Subagent lifecycle
The provider SHALL discover a subagent from either of two sources, whichever comes first:
- an `Agent` or `Task` `tool_use` in a journal
- a `<sessionId>/subagents/agent-<agentId>.meta.json` / `.jsonl` pair

It SHALL link them by the meta file's `toolUseId`. Subagent fields come from these sources:
- `type` from `agentType` or the tool input's `subagent_type`
- `title` from `description`
- `background` from the meta file's `requestShape` being `background`, or the tool input's `run_in_background`
- `parentId` from the journal that contains the launching `tool_use`: absent for the root journal, otherwise that subagent's `agentId`

Completion SHALL be recorded as follows:
- **Foreground:** the `tool_result` for its `tool_use_id` ends it, `failed` when `is_error` and `completed` otherwise.
- **Background:** a `tool_result` saying the agent was launched does not end it. A user record carrying `<task-notification>` whose `<tool-use-id>` matches ends it, mapping `<status>` `completed` → `completed`, `failed` → `failed`, and `killed`/`stopped` → `cancelled`.

Task notifications whose tool-use id is not a known subagent (for example background shell commands) SHALL be ignored.

When the session file goes `idle` or `shell`, open foreground subagents SHALL end `cancelled`, and background ones SHALL stay open. A subagent journal whose last record is an interruption SHALL end `cancelled`. The provider SHALL watch the `subagents/` directory of each live session so a subagent is seen as soon as either file appears.

#### Scenario: Foreground Explore agent
- **WHEN** the root journal records an `Agent` tool use with `subagent_type` `Explore`, and later the matching `tool_result`
- **THEN** `subagent:start` fires with `type` `Explore` and `background` false, then `subagent:end` with `completed`

#### Scenario: Background agent
- **WHEN** a background agent's tool result says it was launched, the session goes `idle`, and later a task notification with its tool-use id and `<status>completed</status>` is recorded
- **THEN** the subagent stays `running` through the idle, then ends `completed`

#### Scenario: Background shell notification
- **WHEN** a task notification names a tool-use id belonging to a `Bash` call
- **THEN** no subagent event is emitted

#### Scenario: Meta file before the tool use is tailed
- **WHEN** `agent-x.meta.json` appears before the root journal's `Agent` record is read
- **THEN** exactly one `subagent:start` fires once the two are linked, not two

#### Scenario: Resumed session with prior subagents
- **WHEN** the provider binds to a resumed session whose history contains five finished subagents
- **THEN** `subagents()` returns five ended subagents and no `subagent:start` is emitted for them

#### Scenario: Subagent transcript
- **WHEN** `transcript()` is called on a subagent
- **THEN** it replays `subagents/agent-<id>.jsonl`, and its records do not affect the root session's activity

### Requirement: Headless sessions
Sessions without a session file (for example `claude -p`) SHALL appear only in history, with `kind` `headless` when the journal's `entrypoint` is not `cli` (observed: `sdk-cli`). A session file whose `kind` is not `interactive` SHALL still be accepted if it passes validation, with `kind` exposed. The provider SHALL NOT infer liveness for sessions without a session file.

#### Scenario: Print-mode run
- **WHEN** `claude -p` runs and leaves a journal but no session file
- **THEN** no live event fires, and `sessions({ since })` returns it with `kind` `headless`

### Requirement: Watch surface
The provider SHALL hold exactly these watches while running: one on `<home>/sessions`, one on each bound root journal, one on each bound session's `subagents/` directory, one on each running subagent journal, and one `watchProcess` per bound pid. It SHALL NOT watch `<home>/projects` recursively. Every watch SHALL use the shared helpers' debounce and latency ceiling.

#### Scenario: Busy session
- **WHEN** a bound session's journal receives 30 appends a second
- **THEN** it is read about once a second and every appended line is eventually yielded in order

### Requirement: Missing Claude home
If `<home>` or `<home>/sessions` does not exist at start, the provider SHALL watch the nearest existing ancestor and begin observing once the directory is created, without polling.

#### Scenario: Claude installed after start
- **WHEN** the provider starts with no `~/.claude`, and then `~/.claude/sessions/<pid>.json` is created for a live process
- **THEN** a session event is emitted for it
