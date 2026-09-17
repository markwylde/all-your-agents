## Context

`activityChanged` compares `lastTurnEndedAt`, and the Claude Code provider emits a `turn-ended` fact for every journal record that ends a turn. Observed in a real journal: one reply stored as a `thinking` record and a `text` record, both `stop_reason: end_turn`, then `system/turn_duration` about 100 ms later, then the session file going idle. That is four ends with different timestamps for one turn.

## Goals / Non-Goals

**Goals:** one `session:activity` per turn end for every provider, live and at bind replay.

**Non-Goals:** changing the exported `reduceActivity` or the `SessionActivity` type; changing which records the Claude Code provider treats as turn ends.

## Decisions

- **Dedupe in the core, not the provider.** The requirement is on the core event, and any provider whose harness writes more than one end marker would hit the same issue. Providers keep reporting facts as they see them.
- **Hidden per-session flag, not a new activity field.** The instance keeps `turnEnded` on each live entry: set by an applied `turn-ended`, cleared by `turn-started` or `tool-started`. A `turn-ended` while it is set is dropped. `SessionActivity` stays as documented.
  - Alternative: infer "already ended" from `lastTurn` being set in the pure reducer. Rejected because a task notification can run tools and end again without a user turn (and must not clear `error`). Then `lastTurn` is still set from the previous turn, so the genuine later end would be dropped.
- **First end wins.** It keeps a `failed` outcome and its error when a `turn_duration` `completed` follows, and matches when the turn actually finished.
- **Replay uses the same rule,** so the activity reconstructed at bind agrees with what live events would have produced.

## Risks / Trade-offs

- [A harness that writes a provisional end and later a corrected outcome would keep the provisional one] → no known harness does this; a provider can emit `turn-started` before a real new turn if needed.
