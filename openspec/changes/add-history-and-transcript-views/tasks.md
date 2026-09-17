## 0. Closable event streams

- [x] 0.1 Add `SessionEventStream` and `InspectContext.signal`; make the core's `events()` abort on `close()` and on the iterator's `return()`, and the Claude Code provider close its tail on abort; verify with a `list-inspect` test that closes while awaiting and finds no watch open, and that the pending `next()` resolves done

## 1. History in the reducer and table

- [x] 1.1 Add `history: 'off' | 'loading' | 'on'` to `ViewState` and `history: boolean` to `Row`; handle the `H` key and a `history` event in `state.ts` (live rows win, `H` off drops only history rows); verify with new `test/cli/state.test.ts` cases for load, toggle off, and a live id also listed by history
- [x] 1.2 Make `visibleRows` show history rows while history is on, independent of `showClosed`; verify with state tests that filter and sort span live and history rows and that live counts exclude them
- [x] 1.3 Show `loading history…` and `+history (N)` in the header, and add `H` and `t` to the help overlay, footer hints and `USAGE`; verify with `test/cli/render.test.ts` cases and the existing width tests

## 2. Transcript view

- [x] 2.1 Add `src/cli/transcript.ts`: `TranscriptItem`, `toItems(event, toolNames)`, and a memoized `transcriptLines(items, cols)` that wraps and sanitizes; verify with unit tests for each item kind, wrapping, multi-line text, and escape sequences
- [x] 2.2 Add `transcript` to `ViewState` with `t`/`Esc` open and close, scroll keys, `follow`, clamping on append and resize, and keys that do not apply ignored; verify with state tests for open-at-end, scroll up then append stays put, `End` follows again, and close keeps the selection
- [x] 2.3 Render the transcript view (title bar, lines, footer hints, empty and loading states); verify with render tests that no line exceeds the width

## 3. Wiring in run.ts

- [x] 3.1 Keep every seen `Session` in one map; on the transition to `history: 'loading'` call `aya.sessions()` once and dispatch the result; use the map for the detail view's subagent fetch; verify with a `test/cli/run.test.ts` case that loads history from the memory harness and opens a historical session's detail
- [x] 3.2 On transcript open iterate `session.events()`, reduce to items, batch with `setImmediate`, and dispatch `transcript:append`; on close or exit call the iterator's `return()`; report stream errors on the status line; verify with run tests: stored records arrive in at most a few frames, an appended record appears, and closing ends the stream
- [x] 3.3 Add `--history` to `args.ts`; start the TUI in `loading`, and make `--once`/`--json` use `sessions()` with live first then newest, `closed` for non-live rows; verify with `args`, `run` and `table` tests

## 4. Docs and verification

- [x] 4.1 Update the README CLI section (flags and key table) and the project description of what the TUI shows; verify the key table matches the help overlay
- [x] 4.2 Run `npm run lint` and `npm test`; verify both pass and the idle-timers tests still pass
- [x] 4.3 Run `node dist/cli/main.js --json --history` and the TUI against the real `~/.claude`; verify history loads and a real transcript opens at the end, scrolls, and closes
- [x] 4.4 Run `openspec validate add-history-and-transcript-views --strict`; verify it passes
