## Why

One Claude Code turn ends several times in its journal: a reply split into several records (thinking, text) each carries `stop_reason: end_turn`, then a `system/turn_duration` record follows, and the session file going idle can close the turn again. Each end has a different timestamp, so `session:activity` fires 3–4 times for a single finished turn, which `demo/watch.ts` shows as repeated "turn completed" lines.

## What Changes

- A turn that has already ended SHALL NOT end again: further turn-end facts are ignored until a new turn or tool call starts. The first end wins (its outcome, error, and `lastTurnEndedAt`).
- `session:activity` therefore fires once when a turn ends.
- `demo/watch.ts` labels activity with no tool and no finished turn as "working" rather than "turn started" (it also follows a finished tool).

## Capabilities

### New Capabilities
<!-- None -->

### Modified Capabilities
- `agent-sessions`: Session activity — a repeated end of the same turn does not change activity or fire `session:activity`.

## Impact

- `src/core/instance.ts` (live turn facts and bind replay). `reduceActivity` and the `SessionActivity` type are unchanged.
- Tests: new core test with scripted duplicate ends; provider test with real Claude Code journal records (split `end_turn` reply plus `turn_duration`).
- `demo/watch.ts` wording.
