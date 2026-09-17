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
Binding a live session to an existing journal SHALL read that journal's bytes once. The records already in the file SHALL seed titles, model, subagents, and activity without producing live turn or subagent-start events, and only records appended afterwards SHALL be handled as live.

#### Scenario: Large journal
- **WHEN** a session binds to a journal that already holds records
- **THEN** each byte of the journal present at bind is read once, and a record appended afterwards is handled exactly once

### Requirement: Record failures are reported, not fatal
A failure while handling one journal record SHALL be reported through `ctx.reportError` and that record skipped. The journal tail and the session's other watches SHALL keep running.

#### Scenario: Handling fails for one record
- **WHEN** handling one appended record fails and a tool-use record is appended after it
- **THEN** `error` is emitted for provider `claude-code` and the session's `activity.tool` still reflects the later record
