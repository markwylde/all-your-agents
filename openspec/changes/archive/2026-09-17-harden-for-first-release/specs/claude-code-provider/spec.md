## MODIFIED Requirements

### Requirement: History listing
`list` SHALL yield one snapshot per root journal under `<home>/projects`. Subagent journals under `<sessionId>/subagents/` SHALL NOT be listed as roots. Each snapshot SHALL take:
- `cwd` from journal records
- `title` by precedence: the latest `custom-title` (`user`), then the latest `ai-title` (`harness`), then the first real user prompt (`prompt`)
- `startedAt` from the first record's timestamp
- `updatedAt` from the last record's timestamp, or the file mtime if no record has one
- `model` from the last assistant record in the portion read that names a real model, or absent

Listing SHALL read only as much of each journal as those fields need.

#### Scenario: Subagents excluded
- **WHEN** a session has `subagents/agent-*.jsonl` files
- **THEN** only the root session is listed

#### Scenario: Model in history
- **WHEN** a journal's last assistant record names model `claude-opus-5`
- **THEN** the listed snapshot has `model` `claude-opus-5`

## ADDED Requirements

### Requirement: Model from the journal
For a bound live session, the provider SHALL report `model` from the root journal's assistant records: the model of the last such record when the session binds, and each change after that. Placeholder models that Claude Code writes on records it generated itself (`<synthetic>`) SHALL be ignored. Subagent journals SHALL NOT change the root session's `model`.

#### Scenario: Model known at bind
- **WHEN** a session binds to a journal whose last assistant record names model `claude-opus-5`
- **THEN** the session has `model` `claude-opus-5` by the time `ready` fires

#### Scenario: Model switched mid-session
- **WHEN** a live session's next assistant record names a different model
- **THEN** `session:update` fires with the new `model`

#### Scenario: Synthetic record
- **WHEN** an assistant record names model `<synthetic>`
- **THEN** the session's `model` is unchanged

### Requirement: Journal read once at bind
Binding a live session to an existing journal SHALL read that journal's bytes once, apart from the one bounded read of its head that validates it (see Journal location). The records already in the file SHALL seed titles, model, subagents, and activity without producing live turn or subagent-start events, and only records appended afterwards SHALL be handled as live.

#### Scenario: Large journal
- **WHEN** a session binds to a journal that already holds records
- **THEN** beyond the bounded validation read, each byte of the journal present at bind is read once, and a record appended afterwards is handled exactly once

### Requirement: Record failures are reported, not fatal
A failure while handling one journal record SHALL be reported through `ctx.reportError` and that record skipped. The journal tail and the session's other watches SHALL keep running.

#### Scenario: Handling fails for one record
- **WHEN** handling one appended record fails and a tool-use record is appended after it
- **THEN** `error` is emitted for provider `claude-code` and the session's `activity.tool` still reflects the later record

### Requirement: Session file events are serviced in order
Events for one session file SHALL be serviced one at a time, in the order they were reported. A later event for that file (a rewrite or its removal) SHALL NOT overtake a bind that is still in progress. A session that is closed, or a provider that is unwatched, while work for it is awaiting the filesystem SHALL NOT have a journal, subagents directory, subagent journal, or process watch attached afterwards.

#### Scenario: File removed while binding
- **WHEN** a session file is removed while that session is still being bound
- **THEN** `session:open` or `session:create` is followed by `session:close`, the session is not live afterwards, and only the sessions directory is still watched

#### Scenario: Process exits while the journal is being read
- **WHEN** a session's process exits while its journal backlog is still being read
- **THEN** `session:close` fires and no watch for that session is open once the read finishes

#### Scenario: Stopped while binding
- **WHEN** the instance is stopped while a session is being bound
- **THEN** no event is emitted for that session and no watch is left open

### Requirement: Prompt title for live sessions
For a bound live session the provider SHALL report the first real user prompt in the root journal as a title with source `prompt`, truncated as in History listing, so a live session and the same session in history have the same title. A slash command that runs a turn is recorded as `<command-message>` markup; its prompt title SHALL be the command as typed (`/name args`), in both the live path and History listing. Shell-mode records (`<bash-input>`, `<bash-stdout>`, `<bash-stderr>`) SHALL NOT be mapped as `user` prompts, start a turn, or title a session.

#### Scenario: Live session with no generated title
- **WHEN** a session binds to a journal holding a user prompt and no `ai-title` or `custom-title`, and its session file has no `name`
- **THEN** the session's `title` is that prompt

#### Scenario: First prompt is a slash command
- **WHEN** the first real user record is `<command-message>opsx:propose</command-message>` with `<command-name>/opsx:propose</command-name>` and `<command-args>add history</command-args>`
- **THEN** the prompt title is `/opsx:propose add history`

#### Scenario: Shell mode is not a prompt
- **WHEN** a user record's text starts with `<bash-input>`
- **THEN** no `user` event is produced, no turn starts, and it does not title the session
