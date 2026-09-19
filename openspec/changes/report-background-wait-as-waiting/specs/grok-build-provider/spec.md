## MODIFIED Requirements

### Requirement: Status mapping
The provider SHALL derive `status` from the bound session's `events.jsonl` phase and turn records, and from the background task rows of its `updates.jsonl`, never from `chat_history.jsonl` or file mtime:
- `waiting_for_model`, `streaming_text`, `streaming_reasoning`, `tool_execution` → `running`
- `permission_prompt` → `waiting`, with `waitingFor` set from the latest `permission_requested` tool name
- after `turn_ended`, or when no turn is open, with a background task still running → `waiting`, with `waitingFor` `monitor` when any running task has kind `monitor`, otherwise `shell`
- after `turn_ended`, or when no turn is open, with no background task running → `idle`

An open turn SHALL always take its status from the phase, whatever tasks are running. Any other phase word SHALL leave `status` absent. MCP setup events (`mcp_*`) SHALL NOT start a turn or set `running`.

#### Scenario: Permission prompt
- **WHEN** the latest phase is `permission_prompt` and the latest `permission_requested` names `run_terminal_command`
- **THEN** `status` is `waiting` and `waitingFor` is `run_terminal_command`

#### Scenario: Turn over
- **WHEN** the latest event is `turn_ended` and no background task is running
- **THEN** `status` is `idle`

#### Scenario: Unknown phase
- **WHEN** `events.jsonl` carries an unknown phase word
- **THEN** `status` is absent

#### Scenario: Chat history disagrees
- **WHEN** `chat_history.jsonl` ends on an assistant `tool_calls` record but `events.jsonl` has already recorded `turn_ended`
- **THEN** `status` is `idle`

#### Scenario: Monitor outlives the turn
- **WHEN** `updates.jsonl` lists a task of kind `monitor` with status `running` and `events.jsonl` then records `turn_ended`
- **THEN** `status` is `waiting` and `waitingFor` is `monitor`

#### Scenario: Backgrounded command outlives the turn
- **WHEN** the only running task has kind `bash` and the turn has ended
- **THEN** `status` is `waiting` and `waitingFor` is `shell`

#### Scenario: Task running inside a turn
- **WHEN** a task is running and the turn is still open in phase `streaming_text`
- **THEN** `status` is `running`

#### Scenario: Monitor wakes the session
- **WHEN** a session is `waiting` for `monitor` and `events.jsonl` records `turn_started`
- **THEN** `status` is `running` with no `waitingFor`

#### Scenario: Last task ends with no turn open
- **WHEN** a session is `waiting` for `shell` and `updates.jsonl` reports that task `completed` or `failed`
- **THEN** `status` is `idle`

### Requirement: Watch surface
The provider SHALL hold exactly these watches while running: one on `<home>/active_sessions.json` via `watchFile` (or the nearest existing ancestor until that file exists), one on each bound root `events.jsonl`, one on each bound root `chat_history.jsonl`, one on each bound root `updates.jsonl`, one on each bound `summary.json`, one on each bound session's `subagents/` directory, one on each running subagent `meta.json` (and the child's `chat_history.jsonl` while its transcript is followed), and one `watchProcess` per distinct pid (shared when several sessions share a pid). It SHALL NOT watch `<home>/sessions` recursively. File watches that target tmp-then-rename files (`active_sessions.json`, `summary.json`, `meta.json`) SHALL use `watchFile`, which watches the parent directory filtered by filename. Every watch SHALL use the shared helpers' debounce and latency ceiling.

#### Scenario: Busy session
- **WHEN** a bound session's `events.jsonl` receives 30 appends a second
- **THEN** it is read about once a second and every appended line is eventually yielded in order

#### Scenario: Streaming updates
- **WHEN** a bound session's `updates.jsonl` receives a chunk row for every streamed token
- **THEN** it is read about once a second, and the session's other watches are not delayed by it

## ADDED Requirements

### Requirement: Background tasks from updates.jsonl
The provider SHALL track a bound root session's background tasks from `updates.jsonl` rows whose `method` is `_x.ai/session/update`. A `background_tasks` row is a snapshot: it SHALL replace the known tasks with its `tasks[]`, keyed by `task_id`, keeping each task's `kind` and `status`. A `task_completed` row SHALL mark `task_snapshot.task_id` as no longer running. Only a task whose `status` is `running` counts as running. Every other row of `updates.jsonl`, including all `session/update` rows, SHALL be ignored without being reported as a failure. A missing `updates.jsonl` SHALL mean no tasks and SHALL NOT be an error; the file SHALL be picked up if it appears later. The file SHALL be read once at bind to seed the task set without emitting intermediate statuses, and only rows appended afterwards SHALL be handled as live. It SHALL be watched like `events.jsonl`, with the shared debounce and latency ceiling, and released when the session closes.

#### Scenario: Bound while a monitor is running
- **WHEN** a session binds whose `events.jsonl` ends on `turn_ended` and whose `updates.jsonl` last snapshot lists a `running` monitor
- **THEN** the catch-up `session:status` is `waiting` with `waitingFor` `monitor`, and no `idle` is emitted first

#### Scenario: Snapshot replaces
- **WHEN** a later `background_tasks` snapshot lists a task as `failed` that an earlier one listed as `running`
- **THEN** that task no longer counts as running

#### Scenario: Streaming chunks ignored
- **WHEN** `updates.jsonl` receives `agent_message_chunk` and `tool_call_update` rows
- **THEN** they change nothing and report no error

#### Scenario: No updates file
- **WHEN** a session directory has no `updates.jsonl`
- **THEN** status follows `events.jsonl` alone and no error is reported

#### Scenario: Malformed row
- **WHEN** a `background_tasks` row has no `tasks` array
- **THEN** it is reported as a record failure and the known tasks are kept
