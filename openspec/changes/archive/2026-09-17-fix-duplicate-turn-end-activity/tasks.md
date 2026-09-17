## 1. Reproduce

- [x] 1.1 Add a core test that scripts turn-started, tool-started, tool-finished, then three turn-ended facts with different `endedAt`, and asserts one `session:activity` for the end with the first `lastTurnEndedAt`; verify it fails on current code
- [x] 1.2 Add a Claude Code provider test that appends real record shapes (assistant `thinking` and `text` records both `end_turn`, then `system/turn_duration`, then session file `idle`) and asserts one "turn completed" activity event; verify it fails on current code

## 2. Fix

- [x] 2.1 Track `turnEnded` per live entry in `src/core/instance.ts`: drop `turn-ended` while set; clear on `turn-started`/`tool-started`; apply the same rule in `activity:replay`; verify both new tests pass
- [x] 2.2 Cover "A new turn can end again" and "failed end is not overwritten by a later completed end" in the core test; verify they pass
- [x] 2.3 Change `demo/watch.ts` wording for activity with no tool and no finished turn to "working"; verify `node ./demo/watch.ts` output

## 3. Verify

- [x] 3.1 Run `npm run lint`, `npm run build`, and `npm test` (with `AYA_SKIP_PACK=0`) and confirm all pass
