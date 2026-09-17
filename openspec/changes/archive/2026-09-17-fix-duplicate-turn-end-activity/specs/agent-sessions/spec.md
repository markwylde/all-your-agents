## MODIFIED Requirements

### Requirement: Session activity
Every session SHALL have an `activity` object describing what its current or last turn is doing, separate from `status`. It has these fields:
- `tool`: the tool call in progress (`id`, `name`, `startedAt`), or absent
- `lastTurn`: `completed`, `failed`, or `interrupted`, or absent before any turn has ended
- `lastTurnEndedAt`: epoch ms
- `error`: the most recent turn failure message, or absent
- `openSubagents`: the count of subagents still running

`session:activity` SHALL fire whenever any of these fields changes. A turn failure SHALL stay on `activity.error` until the next turn starts. Activity is derived from the transcript. It SHALL NOT change `status`, which comes only from the harness's own status source.

A turn ends once. After a turn has ended, further turn-end facts SHALL be ignored until a turn or a tool call starts: they SHALL NOT change `lastTurn`, `lastTurnEndedAt`, or `error`, and SHALL NOT fire `session:activity`.

#### Scenario: Done is idle plus a completed turn
- **WHEN** a session's status becomes `idle` after a turn whose last record is a normal turn end
- **THEN** `activity.lastTurn` is `completed` and `activity.tool` is absent

#### Scenario: Bound at the prompt with no turns
- **WHEN** a session binds and its transcript has no finished turn
- **THEN** `activity.lastTurn` is absent, so consumers can tell "idle, never ran" from "done"

#### Scenario: Error stands through idle
- **WHEN** a turn ends with an API error and status then becomes `idle`
- **THEN** `activity.lastTurn` is `failed` and `activity.error` is set until the next user turn starts, when both clear

#### Scenario: Tool in progress
- **WHEN** a tool call has started and no result for it has been recorded
- **THEN** `activity.tool` names it, and it clears when its result is recorded

#### Scenario: Activity never overrides status
- **WHEN** the transcript shows an unfinished tool call but the harness reports `idle`
- **THEN** `status` is `idle`, and `activity.tool` is cleared with `lastTurn` set to `interrupted`

#### Scenario: One turn ended several times
- **WHEN** a finished turn is recorded as several turn ends (a reply split into records that each end the turn, then a turn-duration record, then the session going idle)
- **THEN** `session:activity` fires once for the end, and `lastTurn` and `lastTurnEndedAt` come from the first end

#### Scenario: A new turn can end again
- **WHEN** a turn has ended and a new turn or tool call then starts and ends
- **THEN** that later end updates `lastTurn` and `lastTurnEndedAt` and fires `session:activity`
