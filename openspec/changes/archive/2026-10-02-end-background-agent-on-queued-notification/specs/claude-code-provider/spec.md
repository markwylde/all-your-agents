## MODIFIED Requirements

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
- **Background:** a `tool_result` saying the agent was launched does not end it. A task notification whose `<tool-use-id>` matches ends it, mapping `<status>` `completed` → `completed`, `failed` → `failed`, and `killed`/`stopped` → `cancelled`.

A task notification is recorded in one of two forms, and either SHALL end the subagent:
- a user record carrying `<task-notification>`, written when the notification starts a turn
- an `attachment` record whose `attachment.type` is `queued_command`, whose `commandMode` or `origin.kind` is `task-notification`, and whose `prompt` carries `<task-notification>`, written when the notification is queued behind a running turn

A notification recorded in both forms SHALL end its subagent once. A `queued_command` attachment that is not a task notification (for example a prompt the user queued) SHALL NOT end a subagent. Task notifications whose tool-use id is not a known subagent (for example background shell commands) SHALL be ignored.

When the session file goes `idle` or `shell`, open foreground subagents SHALL end `cancelled`, and background ones SHALL stay open. A subagent journal whose last record is an interruption SHALL end `cancelled`. The provider SHALL watch the `subagents/` directory of each live session so a subagent is seen as soon as either file appears.

#### Scenario: Foreground Explore agent
- **WHEN** the root journal records an `Agent` tool use with `subagent_type` `Explore`, and later the matching `tool_result`
- **THEN** `subagent:start` fires with `type` `Explore` and `background` false, then `subagent:end` with `completed`

#### Scenario: Background agent
- **WHEN** a background agent's tool result says it was launched, the session goes `idle`, and later a task notification with its tool-use id and `<status>completed</status>` is recorded
- **THEN** the subagent stays `running` through the idle, then ends `completed`

#### Scenario: Background agent finishing during a turn
- **WHEN** a background agent finishes while the root turn is still running, and its task notification is recorded as a `queued_command` attachment with `<status>completed</status>`
- **THEN** the subagent ends `completed`

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
