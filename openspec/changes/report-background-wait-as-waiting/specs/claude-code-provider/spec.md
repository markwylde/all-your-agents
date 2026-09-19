## MODIFIED Requirements

### Requirement: Status mapping
The provider SHALL map Claude Code status words as follows:
- `busy` → `running`
- `waiting` → `waiting`, with `waitingFor` copied
- `shell` → `waiting`, with `waitingFor` `shell`: the turn is over and a background shell command that will wake the session is still running
- `idle` → `idle`

Any other word SHALL leave `status` absent. Status SHALL come only from the session file, never from journal content. A change between `shell` and `idle`, in either direction, SHALL produce `session:status`. The `shell` word SHALL end the open turn and cancel foreground subagents exactly as `idle` does, and a following `idle` SHALL NOT end the turn a second time.

#### Scenario: Journal disagrees with file
- **WHEN** the session file says `idle` while the last journal record is an unfinished assistant turn
- **THEN** `status` is `idle`

#### Scenario: Unknown word
- **WHEN** the session file carries an unknown status word
- **THEN** `status` is absent

#### Scenario: Background shell outlives the turn
- **WHEN** the session file goes `busy` → `shell` → `busy` → `idle`
- **THEN** `session:status` reports `running`, `waiting` with `waitingFor` `shell`, `running`, then `idle` with no `waitingFor`

#### Scenario: Shell ends the turn once
- **WHEN** the session file goes from `busy` to `shell` and later to `idle` with no new turn between
- **THEN** the turn ends once, at the `shell` write, and `activity.lastTurnEndedAt` does not move at the `idle` write

#### Scenario: Bound while in shell
- **WHEN** a session file already carrying `shell` is first seen
- **THEN** the catch-up `session:status` is `waiting` with `waitingFor` `shell`

#### Scenario: Background agent only
- **WHEN** a background subagent is still running and the session file says `idle`
- **THEN** `status` is `idle`
