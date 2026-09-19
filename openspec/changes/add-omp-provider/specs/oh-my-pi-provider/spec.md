## Purpose

Observes oh-my-pi (`omp`) sessions from the presence files, terminal breadcrumbs, prompt history and JSONL transcripts omp itself writes, and exposes them through the harness-neutral session API as a fourth built-in provider.

## ADDED Requirements

### Requirement: Built in by default, isolated in code
The oh-my-pi provider SHALL be included in `builtInProviders` and SHALL also be importable on its own. The provider id SHALL be `oh-my-pi` and the harness SHALL be `OhMyPi`. Its home SHALL be the `home` option when given, otherwise `~/<PI_CONFIG_DIR>` when that variable is set, otherwise `~/.omp`. The agent directory SHALL be `PI_CODING_AGENT_DIR` when set and no `home` was passed, otherwise `<home>/agent`. When no `home` was passed, `XDG_DATA_HOME` / `XDG_STATE_HOME` are set, and `$XDG_*/omp` exists (omp's own test for "migrated"), the provider SHALL resolve the same directories omp does: sessions and `history.db` under `$XDG_DATA_HOME/omp`, breadcrumbs and `run/daemons` under `$XDG_STATE_HOME/omp`, with the `agent/` level flattened away. Upstream `pi` (`~/.pi`) SHALL NOT be observed.

#### Scenario: Custom home
- **WHEN** the provider is created with a home pointing at a fixture directory
- **THEN** it reads only beneath that directory and the session files its breadcrumbs name

#### Scenario: Root name from the environment
- **WHEN** `PI_CONFIG_DIR` is `.omp-test` and no home is passed
- **THEN** the provider reads beneath `~/.omp-test`

### Requirement: Profiles are observed
Every directory `<home>/profiles/<name>`, `$XDG_DATA_HOME/omp/profiles/<name>` and `$XDG_STATE_HOME/omp/profiles/<name>` SHALL be observed as a further root with the same layout (`agent/`, `run/`, redirected as omp redirects it), including a profile created after `watch` started. A profile deleted from every one of those places SHALL close its bound sessions and stop being watched. Sessions from a profile SHALL be reported like any other; a session id SHALL be reported once even if two roots name it.

#### Scenario: Session in a profile
- **WHEN** an omp process started with `OMP_PROFILE=work` writes its presence file and breadcrumb under `<home>/profiles/work`
- **THEN** its session is bound and emitted

#### Scenario: Profile created later
- **WHEN** `<home>/profiles/new` appears after start and a process then runs in it
- **THEN** its session is emitted without polling

#### Scenario: Profile only under XDG
- **WHEN** `$XDG_DATA_HOME/omp/profiles/moved` exists and `<home>/profiles/moved` does not
- **THEN** `moved` is observed, its sessions read from `$XDG_DATA_HOME/omp/profiles/moved/sessions`

#### Scenario: Profile deleted
- **WHEN** `<home>/profiles/work` holding a bound session is removed
- **THEN** that session closes and nothing under the profile is watched any more

### Requirement: Live sessions from presence files and breadcrumbs
omp keeps a registry (ADR 0002): each running process writes `run/daemons/<hash>/clients/<pid>-<uuid>.json` holding `pid` and `projectDir` at launch and removes it on a clean exit, and each process on a terminal writes `agent/terminal-sessions/<terminal-id>` naming its cwd (line 1) and current session file (line 2), with an optional `fresh` line meaning that file does not exist yet. The provider SHALL watch both directories, and that SHALL be how it discovers sessions. It SHALL NOT discover sessions from transcript writes, file mtimes, "newest file", or the process table.

A breadcrumb SHALL be bound as a live session only when a presence file names a live pid whose controlling terminal, from the one-time `tty(pid)` probe with `/` replaced by `-`, equals the breadcrumb's file name. Breadcrumbs whose name is not a terminal device name (`zellij-…`, `tmux-…`, `kitty-…`, `apple-…` and the like) SHALL be ignored. When several live presence pids share that terminal, the most recently started one whose start time is not after the breadcrumb's modification time SHALL be bound. A session file recorded relative to the cwd SHALL be resolved against it. The session id SHALL be the UUID in the session file's name (`<timestamp>_<uuid>.jsonl`), or, for a custom-named file (`--session notes/work`), the id in its header; such a file binds nothing until it exists, and omp rewrites the breadcrumb when it does. When `tty` is not implemented the provider SHALL emit no live sessions and SHALL still serve history.

A presence file with no matching breadcrumb (an `omp -p` whose stdin is not a terminal) SHALL bind nothing. An `omp -p` run on a terminal writes a breadcrumb and binds like any other run; that run appears in history.

#### Scenario: Launch in a terminal
- **WHEN** omp starts on `ttys024`, writing `clients/18510-….json` and `terminal-sessions/ttys024` with a `fresh` line
- **THEN** `session:create` fires with pid 18510, the cwd from the breadcrumb, and the id from the session file name, before any transcript exists

#### Scenario: Present before start
- **WHEN** an omp process was already running when `watch` started
- **THEN** the initial scan binds it and `session:open` is part of catch-up

#### Scenario: Old breadcrumb, no process
- **WHEN** `terminal-sessions/ttys009` exists from a process that has exited and no presence pid is on that terminal
- **THEN** no session is emitted for it

#### Scenario: Headless run
- **WHEN** `omp -p` runs with no terminal on its stdin, writing a presence file and no breadcrumb
- **THEN** no live session is emitted, and the run is listed by `sessions()` afterwards

#### Scenario: Presence seen before breadcrumb
- **WHEN** the presence file's notification is serviced before the breadcrumb exists
- **THEN** nothing is bound yet, and the session binds when the breadcrumb's create is serviced

#### Scenario: No tty probe
- **WHEN** the injected `Processes` does not implement `tty`
- **THEN** no live oh-my-pi session is emitted and `list` still returns history

### Requirement: Active session validation
The provider SHALL accept a live binding only when all of these hold:
- the presence file parses, under a size bound, with a positive integer `pid`
- that process exists
- the breadcrumb parses, under a size bound, with a non-empty cwd line and a session file path ending `<timestamp>_<uuid>.jsonl`
- the breadcrumb's modification time is not earlier than the process start time minus 5 seconds (a process that never rewrote the breadcrumb does not own it); when the start time is unknown this check is skipped
- when the session file exists, its second line parses as a `session` header whose `id` equals the UUID in the file name

A candidate that fails SHALL produce no session event and SHALL leave the watches running. The provider SHALL NOT guess.

#### Scenario: Stale breadcrumb, new process in another mode
- **WHEN** a live presence pid is on `ttys024`, started at 10:00, and `terminal-sessions/ttys024` was last written at 09:00
- **THEN** no session is bound from that breadcrumb

#### Scenario: Corrupt presence file
- **WHEN** a presence file holds invalid JSON
- **THEN** no event is emitted and the watch keeps running

#### Scenario: Header id mismatch
- **WHEN** the named session file's header `id` differs from the UUID in its name
- **THEN** no session is bound

### Requirement: Create vs open
When an accepted binding appears, the provider SHALL emit `session:create` if the breadcrumb is `fresh` or the session file does not exist, and `session:open` otherwise. The decision SHALL NOT be revised later.

#### Scenario: Resumed conversation
- **WHEN** `omp --continue` starts and its breadcrumb names an existing session file
- **THEN** `session:open` is emitted

#### Scenario: Fresh session later materialises
- **WHEN** a session bound as created gets its transcript file and the breadcrumb loses its `fresh` line
- **THEN** no second `session:create` or `session:open` fires

### Requirement: Session switch inside one process
When a bound process's breadcrumb is rewritten to name a different session file (`/new`, `/resume`, `/tree`, a fork), the provider SHALL emit `session:close` for the old session and then `session:create` or `session:open` for the new one with the same pid. The new session SHALL NOT inherit the old one's status, title, activity or subagents. A rewrite that names the same session id at a new path SHALL be handled as a relocation, not a switch.

#### Scenario: New session
- **WHEN** the user runs `/new` and the breadcrumb for pid P changes from session A to a fresh session B
- **THEN** `session:close(A)` is emitted, then `session:create(B)` with pid P

### Requirement: Process exit
The provider SHALL close a session when its presence file is removed or when its process exits, whichever is seen first, and SHALL emit one `session:close`. It SHALL call `watchProcess(pid)` once per bound pid. A presence file left behind by a killed process SHALL be ignored afterwards. When `watchProcess` is unsupported, the provider SHALL re-validate bound pids while servicing any presence or breadcrumb notification, and on `reconcile(pid)`. It SHALL NOT check pids on a timer. The breadcrumb is never deleted by omp, so its continued existence SHALL NOT keep a session open.

#### Scenario: Clean exit
- **WHEN** the user quits omp and the presence file is deleted
- **THEN** `session:close` fires once and `running()` no longer lists the session

#### Scenario: Killed
- **WHEN** a bound process is `kill -9`ed and its presence file and breadcrumb remain
- **THEN** `session:close` fires from the exit event, and the stale files bind nothing afterwards

### Requirement: Status mapping
The provider SHALL derive `status` from the records of the bound session's transcript, in file order, never from mtime or elapsed time:
- a `message` with role `user`, or role `toolResult`, as the last conversation record → `running`
- an assistant `message` with `stopReason` `toolUse` → `running`
- an assistant `message` with `stopReason` `stop` or `length` → `idle`
- an assistant `message` with `stopReason` `error` or `aborted` → `idle`
- no conversation record yet → `idle`

While a `toolCall` named `ask` has a `tool_execution_start` marker and no `toolResult`, `status` SHALL be `waiting` with `waitingFor` `ask`. omp does not persist permission approval prompts (the prompt happens before the assistant message is written), so the provider SHALL NOT report `waiting` for them and SHALL NOT infer it from elapsed time; such a session reads `running`. Messages with role `developer` or `fileMention`, `custom_message` entries, and every other entry type SHALL leave `status` unchanged.

#### Scenario: Prompt submitted
- **WHEN** a user message is appended to a materialised transcript
- **THEN** `status` becomes `running`

#### Scenario: Turn over
- **WHEN** the last conversation record is an assistant message with `stopReason` `stop`
- **THEN** `status` is `idle`

#### Scenario: Ask tool pending
- **WHEN** an assistant message calls `ask`, its `tool_execution_start` marker follows, and no `toolResult` for that call exists
- **THEN** `status` is `waiting` and `waitingFor` is `ask`, until the `toolResult` arrives

#### Scenario: Approval prompt is not observable
- **WHEN** omp is blocked on a permission approval and nothing has been appended
- **THEN** `status` stays `running`, and no timer is armed to guess otherwise

### Requirement: First turn from prompt history
omp does not write a session's transcript until its first assistant message ends. On submit it inserts the prompt into the `history` table of `agent/history.db` with `session_id`, `cwd` and `created_at`. When a `sqlite` reader is available, the provider SHALL watch `agent/history.db-wal` for held-open writes and, on each notification, read only the rows added or re-submitted since the last one it saw. omp upserts on the prompt text, so a prompt typed before keeps its row id and only moves `created_at` and `session_id`; the provider SHALL track `created_at` as well as the id. A new row whose `session_id` is a bound session that has no transcript yet SHALL start a turn (`status` `running`) and SHALL supply the `prompt` title. Rows for unbound sessions, and rows for sessions that already have a transcript, SHALL be ignored. When the transcript then appears, the records already in it SHALL be reconciled with that open turn: the turn SHALL NOT be started a second time, and its tools and its end SHALL come from the transcript. When no `sqlite` reader is available (a runtime without SQLite, or `sqlite: false`), the provider SHALL still work, and a new session SHALL read `idle` until its transcript appears. The provider SHALL NOT read any other table, and SHALL NOT open `agent.db` or `models.db`.

#### Scenario: First prompt of a new session
- **WHEN** a bound fresh session has no transcript and a `history` row with its `session_id` is committed
- **THEN** `status` becomes `running` and `title` is that prompt, before any transcript exists

#### Scenario: A prompt typed before
- **WHEN** a bound fresh session's first prompt is text already in `history`, so omp updates that row's `created_at` and `session_id`
- **THEN** `status` becomes `running` and `title` is that prompt, as for a new row

#### Scenario: Transcript appears mid-turn
- **WHEN** that session's transcript then appears holding the user message and an assistant message with `stopReason` `stop`
- **THEN** one turn is reported as started and completed, not two

#### Scenario: First turn fails
- **WHEN** the first transcript holds the user message and an assistant message with `stopReason` `error`
- **THEN** the turn started from history ends `failed` with that `errorMessage`

#### Scenario: No SQLite reader
- **WHEN** `sqlite` is absent and a new session's first prompt is submitted
- **THEN** no error is reported, `status` stays `idle`, and it becomes correct when the transcript appears

#### Scenario: Backlog at start
- **WHEN** `watch` starts and `history` already holds rows
- **THEN** none of them starts a turn

### Requirement: Turn activity
For a bound session the provider SHALL report turn facts from the transcript:
- a user `message` starts a turn and clears any standing error; an assistant or `toolResult` message arriving when no turn is open (omp retrying after a provider error) also starts one
- each `toolCall` block in an assistant message starts a tool, with `activity.tool.id` from the block's `id` and the name from its `name`; the `tool_execution_start` marker with the same `toolCallId` SHALL NOT start it a second time
- the `toolResult` message with the same `toolCallId` finishes that tool; `isError` on a tool result does not end the turn
- an assistant message with `stopReason` `stop` or `length` ends the turn `completed`
- `stopReason` `error` ends it `failed` with `activity.error` from `errorMessage`
- `stopReason` `aborted` ends it `interrupted`
- a `custom` `session_exit` entry, or the session closing, while a turn is open ends it `interrupted`

At bind the provider SHALL replay the transcript to reconstruct activity without emitting intermediate facts. A turn left open by an earlier process (its last record predates the bound process's start and no `session_exit` closed it) SHALL end `interrupted` at the process start, leaving the session `idle`.

#### Scenario: Tool call
- **WHEN** an assistant message with a `bash` `toolCall`, its `tool_execution_start` marker, and its `toolResult` are appended
- **THEN** one tool start and one tool finish are reported, keyed by the call id

#### Scenario: Provider error
- **WHEN** an assistant message has `stopReason` `error` and an `errorMessage`
- **THEN** `activity.lastTurn` is `failed` and `activity.error` is that message until the next turn starts

#### Scenario: Retry after an error
- **WHEN** an assistant message with `stopReason` `toolUse` follows an `error` assistant message with no user message between them
- **THEN** a new turn starts and `status` is `running`

#### Scenario: Replay at bind is silent
- **WHEN** the provider binds to a session whose transcript holds forty finished turns
- **THEN** one `session:activity` reflecting the final state is emitted, not forty

#### Scenario: Turn left open by a killed process
- **WHEN** `omp --continue` resumes a transcript whose tail is a user message written before that process started
- **THEN** that turn is `interrupted` and the session is `idle` until a new turn starts

### Requirement: Titles and model
The provider SHALL report titles from the transcript's `title_change` entries: `source` `user` as a `user` title, otherwise `harness`. The first real user prompt (from the transcript, or from `history` for a session with no transcript yet) SHALL be reported as a `prompt` title, truncated as the other providers do. The in-place title slot on line 1 SHALL be read only by `list`; it SHALL NOT be re-read for a live session. The `model` SHALL come from the latest `model_change` entry or, when later, the `provider/model` of the latest assistant message: the model at bind and each change after that. Subagent transcripts SHALL NOT change the root session's title or model.

#### Scenario: Generated title
- **WHEN** a `title_change` with `source` `auto` and title `Lighthouse Keeper Short Story` is appended
- **THEN** `title` becomes that string with source `harness`, replacing the prompt title

#### Scenario: Model known at bind
- **WHEN** a session binds to a transcript whose `model_change` names `xai-oauth/grok-4.6`
- **THEN** the session has `model` `xai-oauth/grok-4.6` by the time `ready` fires

### Requirement: Subagent lifecycle
omp runs subagents in the parent's process and writes each one's transcript as `<session-file-without-.jsonl>/<AgentId>.jsonl`, created when the subagent starts. A subagent's own subagents land one directory down, as `<Parent>/<Parent>.<Child>.jsonl`. The provider SHALL watch a bound session's artifact directory, and the directories under it, and SHALL start a subagent when such a file appears. Fields:
- `id`: the file's name without `.jsonl`, which is omp's own id for the agent and the id its parent's `task` result uses (for example `PowTwoTen`, `NestParent.MulChild`)
- `title`: the part of that id after its last `.`
- `type`: `agent` from the child's `session_init` entry when present, otherwise `subagent`
- `parentId`: absent when the child header's `parentSession` names the root session file, otherwise the id of the subagent whose transcript it names. The match SHALL be by file name, not by path: omp canonicalises paths (`/tmp` and `/private/tmp`), a breadcrumb may not
- `background`: true when the parent's `task` result had already said it spawned that agent asynchronously (`details.async`, with the agent's id in `details.progress`) by the time the subagent starts, otherwise false. The core fixes `background` at start, so it is not revised later. `subagents()` for a session known only from history SHALL read the same flag from the parents' transcripts, and SHALL end a child whose own transcript never says how it ended with its parent's report of it, else `cancelled`

Completion SHALL be recorded from whichever of these speaks first, one `subagent:end` per subagent:
- in the child's transcript, a `toolResult` for the `yield` tool: `details.status` `success` → `completed`, anything else → `failed`. An assistant message with `stopReason` `stop` or `length` SHALL NOT end the subagent: omp then reminds the agent to yield, and it carries on
- in the parent's transcript (the root's, or a subagent's for its own children), a `toolResult` whose `details.results[]` or `details.jobs[]` names the agent with a final status, or an `async-result` `custom_message` whose `<task-result id=… status=…>` names it: `completed` → `completed`, `failed` / `error` → `failed`, `cancelled` / `aborted` → `cancelled`
- an assistant message with `stopReason` `error` → `failed`
- an assistant message with `stopReason` `aborted`, or a `session_exit` entry while the child is still open → `cancelled`
- the parent session closing while the child is still open → `cancelled`

Other files in the artifact directory (`*.md`, `*.log`, `*.json`) SHALL be ignored. Child transcripts SHALL NOT be emitted as sessions, SHALL NOT be listed by `list`, and SHALL NOT affect the root session's status or activity. A later record on an ended child SHALL NOT restart it. At bind, children whose transcripts already show an end SHALL be reported through `subagents()` as ended and SHALL NOT emit `subagent:start`; a child still open SHALL be seeded as running.

#### Scenario: Three parallel subagents
- **WHEN** `PowTwoTen.jsonl`, `MulSeventeenTwentyThree.jsonl` and `DivOneFortyFour.jsonl` appear in the bound session's artifact directory, and each later records a successful `yield` result
- **THEN** three `subagent:start` events fire with those titles and the `type` from each `session_init`, then three `subagent:end` events with `completed`

#### Scenario: Background subagent
- **WHEN** the root's `task` result lists `PowTwoTen` with `details.async`, the child transcript then appears, the root's turn ends while the child is still open, and the child later yields
- **THEN** `subagent:start` fires with `background` true, the subagent stays `running` through the root's idle, then ends `completed`

#### Scenario: Stops, is reminded, then yields
- **WHEN** a child records an assistant message with `stopReason` `stop`, then a `developer` reminder, then a successful `yield`
- **THEN** the subagent stays `running` until the `yield` result, then ends `completed`, once

#### Scenario: Parent reports first
- **WHEN** the root records a `hub` result whose `jobs[]` names a running agent as `completed` before that child's `yield` is read
- **THEN** one `subagent:end` fires with `completed`, and the child's later `yield` adds nothing

#### Scenario: Nested subagent
- **WHEN** `NestParent/NestParent.MulChild.jsonl` appears and its `parentSession` names `NestParent.jsonl`
- **THEN** a subagent `NestParent.MulChild` starts with title `MulChild` and `parentId` `NestParent`

#### Scenario: Yield and exit both seen
- **WHEN** a child records a successful `yield` and, at process exit, a `session_exit`
- **THEN** exactly one `subagent:end` fires, with `completed`

#### Scenario: Subagent transcript
- **WHEN** `transcript()` is called on a subagent
- **THEN** it replays that child's transcript, and its records do not affect the root session's activity

### Requirement: Transcript rewrite and relocation
omp usually appends to the transcript but sometimes replaces it by writing a temporary sibling and renaming it over the file (first creation, migration, recovery), and `/move` relocates it, rewriting the breadcrumb with the same session id at a new path. In both cases the provider SHALL keep the session open, switch its tail to the file now at the session's path, and replay it silently. A replacement is recognised by the file's inode changing (`FsStat.ino`); a file interface that reports no inode cannot show one, and the provider SHALL then carry on with the tail it has: status, title and model are kept, and no `subagent:start` fires for subagents already ended. A changed `cwd` SHALL produce `session:update`.

#### Scenario: Replaced in place
- **WHEN** a bound transcript is replaced by a rename and records are then appended to the new file
- **THEN** no `session:close` fires and the appended records are handled once

#### Scenario: Moved
- **WHEN** the breadcrumb is rewritten with the same session id at a path under another cwd directory
- **THEN** `session:update` reports the new `cwd`, the session stays live, and later appends are tailed from the new path

### Requirement: History listing
`list` SHALL yield one snapshot per transcript directly under `<agent>/sessions/<encoded-cwd>/` in every root, and one per absolute path recorded in `<agent>/custom-session-files/` (sessions kept elsewhere with `--session` or `--session-dir`, whose id comes from the header alone). Transcripts in artifact subdirectories are subagents and SHALL be excluded. Each snapshot SHALL take, from a bounded read of the file's head:
- `id` from the header, which SHALL equal the UUID in the file name, when the name has one, or the file is skipped
- `cwd` from the header, never from the directory name (the encoding is lossy)
- `startedAt` from the header `timestamp`
- `title` from the line-1 title slot when it is non-empty (`source` `user` → `user`, otherwise `harness`), else the first user prompt (`prompt`)
- `updatedAt` from the file's modification time
- `model` from a bounded read of the tail (the last assistant message), else the head's `model_change`, else absent

omp records nothing that distinguishes a headless run, so `kind` SHALL be absent for sessions known only from history and `interactive` for sessions bound through a breadcrumb. `since` SHALL short-circuit on modification time before any read. Listing SHALL NOT parse a whole transcript except as needed for a missing title. A file whose head is malformed or oversized SHALL be skipped.

#### Scenario: Subagents excluded
- **WHEN** a session file and its artifact directory holding three child transcripts exist
- **THEN** only the parent is listed

#### Scenario: Title from the slot
- **WHEN** line 1 holds `{"type":"title","title":"Lighthouse Keeper Short Story","source":"auto",…}`
- **THEN** the snapshot's title is that string and the rest of the file is not parsed for a title

#### Scenario: Cwd from the header
- **WHEN** a transcript lies under `--private-tmp-proj--` and its header says `cwd` `/tmp/proj`
- **THEN** the snapshot's `cwd` is `/tmp/proj`

### Requirement: Record mapping
The provider SHALL map transcript entries to normalized events:
- `message` role `user` with non-empty text → `user`
- `message` role `assistant`: each `text` block → `assistant` with `model` `provider/model`; each `toolCall` block → `tool` with `id` and `name`; `thinking` blocks are not mapped
- `message` role `toolResult` → `tool-result` with `id` from `toolCallId` and `isError`
- an assistant message with `stopReason` `error` → `error` with `errorMessage`, then `turn-end`; `stop`, `length` and `aborted` → `turn-end`
- `title_change` → `title`
- a `task` `toolResult` whose `details.progress[]` names agents, or a child transcript → `subagent`; the child's end → `subagent-end`

The title slot, the `session` header, `model_change`, `thinking_level_change`, `service_tier_change`, `model_usage`, `compaction`, `branch_summary`, `label`, `credential_pin`, `session_init`, `mode_change`, `ttsr_injection`, `custom`, `custom_message`, messages with role `developer` or `fileMention`, and unknown types SHALL NOT be mapped as `user` prompts. Unknown entry types SHALL be unmapped, not errors. Entries SHALL be yielded in file order; the `parentId` tree is not reconstructed.

#### Scenario: Async result is not a prompt
- **WHEN** a `custom_message` with `customType` `async-result` is appended
- **THEN** no `user` event is produced and no turn starts

#### Scenario: Captured real transcript
- **WHEN** the captured fixture transcript from omp is replayed
- **THEN** the produced sequence matches the checked-in expected output

### Requirement: Watch surface
For each root the provider SHALL hold exactly these watches while running: one on `agent/terminal-sessions`, one on `run/daemons` and one on each `<hash>/clients` directory under it (including those created later), and, when a `sqlite` reader is available, one held-open `watchFile` on `agent/history.db-wal`. One watch on `<home>/profiles`. For each bound session: one on the directory holding its transcript (servicing only that session's file name and artifact directory name), one `tailJsonl` on the transcript once it exists, one on its artifact directory once it exists, one `tailJsonl` per running subagent, and one `watchProcess` per bound pid. It SHALL NOT watch `agent/sessions` recursively, `logs/`, `blobs/`, or the `.lock` sidecars. Every watch SHALL use the shared helpers' debounce and latency ceiling.

#### Scenario: Busy session
- **WHEN** a bound session's transcript receives 30 appends a second
- **THEN** it is read about once a second and every appended line is eventually yielded in order

#### Scenario: Sibling session churn
- **WHEN** another session in the same cwd directory is written
- **THEN** the bound session's transcript is not re-read

### Requirement: Missing home
If `<home>`, `agent/terminal-sessions` or `run/daemons` does not exist at start, the provider SHALL watch the nearest existing ancestor and begin observing once the directory is created, without polling.

#### Scenario: omp installed after start
- **WHEN** the provider starts with no `~/.omp`, and omp is then installed and launched in a terminal
- **THEN** a session event is emitted for it

### Requirement: Transcript read once at bind
Binding a live session to an existing transcript SHALL read that file's bytes once, apart from the one bounded read of its head that validates it. The records already in the file SHALL seed title, model, subagents and activity without producing live turn or subagent-start events, and only records appended afterwards SHALL be handled as live.

#### Scenario: Large transcript
- **WHEN** a session binds to a transcript that already holds records
- **THEN** beyond the bounded validation read, each byte present at bind is read once, and a record appended afterwards is handled exactly once

### Requirement: Record failures are reported, not fatal
A failure while handling one transcript record, one breadcrumb, one presence file or one history row SHALL be reported through `ctx.reportError` and that item skipped. A failed `sqlite` query SHALL be reported once per cause and SHALL NOT stop file observation. The session's other watches SHALL keep running.

#### Scenario: Handling fails for one record
- **WHEN** handling one appended record fails and a tool-call record is appended after it
- **THEN** `error` is emitted for provider `oh-my-pi` and the session's `activity.tool` still reflects the later record

#### Scenario: History schema changed
- **WHEN** the `history` table lacks an expected column
- **THEN** one `error` is emitted, first-turn detection stops, and live sessions keep being reported from files

### Requirement: Events are serviced in order
Notifications for one terminal breadcrumb, and for one presence directory, SHALL be serviced one at a time in the order reported. A later event SHALL NOT overtake a bind still in progress. A session that is closed, or a provider that is unwatched, while work for it is awaiting the filesystem SHALL NOT have a tail, directory watch or process watch attached afterwards.

#### Scenario: Process exits while binding
- **WHEN** a session's process exits while its transcript backlog is still being read
- **THEN** `session:close` fires and no watch for that session is open once the read finishes

#### Scenario: Stopped while binding
- **WHEN** the instance is stopped while a session is being bound
- **THEN** no event is emitted for that session and no watch is left open
