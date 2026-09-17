## Context

See proposal.md for motivation. What shapes the design:

- The TUI is a pure reducer (`state.ts`: `applyEvent`, `applyKey`) plus a pure renderer (`render.ts`), driven by `run.ts`, which owns every side effect. `run.ts` already reacts to a state transition by doing I/O (it fetches subagents when the detail view opens). Both features follow that pattern.
- ADR 0001 and the CLI's "Event-driven redraw" requirement: no timers, redraw only on a library event, a key, or a resize, at most once per event-loop turn.
- The library already provides everything needed: `sessions()` for history, `session.events()` for a transcript that follows, `session.subagents()` for both live and historical sessions.
- Journals can be large. A transcript can be tens of thousands of records.

## Goals / Non-Goals

**Goals:**
- Historical sessions and transcripts reachable from the TUI with the keys and table the user already knows.
- Opening a large transcript costs one read and a few redraws.

**Non-Goals:**
- Searching inside a transcript, copying text, or rendering markdown.
- Subagent transcripts (the library supports them; the view can grow into it later).
- Paging `sessions()`; the table already scrolls and filters.

## Decisions

### 1. History rows are closed rows that came from disk
A `Row` gains `history: boolean`. History rows are `closed: true`, so the dimmed `closed` rendering, the sort rank and the live counts already do the right thing. `visibleRows` shows a row when it is live, when `showClosed` is on, or when it is a history row and history is on. `H` off drops rows with `history: true`; rows that closed during this run are untouched and still follow `c`.

Alternative: a separate history screen with its own table. Rejected: it duplicates sort, filter, selection and detail for no gain, and the interesting question ("what was that session doing in this folder?") spans live and historical rows.

### 2. `history` is a tri-state driven by the reducer, loaded by `run.ts`
`ViewState.history` is `'off' | 'loading' | 'on'`. `H` moves `off → loading` (or `on → off`). `run.ts` sees the transition to `loading`, calls `aya.sessions()` once, and dispatches `{ type: 'history', sessions }`, which moves to `on`. A live session that history also lists keeps its live row: the reducer skips ids whose row is not closed. `--history` sets the initial state to `loading`.

`run.ts` keeps the `Session` objects it has seen (live and from history) in one map, so the detail view's subagent fetch and the transcript work for both.

### 3. The transcript is one `events()` stream, batched by `setImmediate`
`t` sets `ViewState.transcript = { sessionId, items: [], loading: true, scroll: 0, follow: true }`. `run.ts` sees it open and iterates `session.events()`; it sees it close (or the command exit) and calls the iterator's `return()`, which releases the journal watch.

Each `SessionEvent` is reduced at once to a small `TranscriptItem` (`kind`, `text`, `at`, and for tools the name), so `raw` records are not retained. Items are buffered and handed to the reducer in one `transcript:append` event per `setImmediate`. The stored records arrive as one unbroken chain of microtasks, so they land in a single batch and a single redraw; later appends land in small batches.

`setImmediate` is not a timer in ADR 0001's sense: it is armed only by a library event, fires once on the next loop iteration, and nothing is pending while nothing changes. The existing timer guard (`setTimeout`/`setInterval`) and the idle-timers test stay meaningful. `queueMicrotask`, which the redraw scheduler uses, would not batch here: each record is delivered in its own microtask, so a microtask flush would run once per record.

Alternatives:
- `session.transcript()` re-read whenever the session's activity changes: re-parses the whole journal several times a second for a busy agent.
- Keep `SessionEvent[]` in state: holds every raw record in memory for the life of the view.

### 3a. Cancelling an idle `events()` stream
`events()` is an async generator chain (core → provider → `tailJsonl`). Calling `return()` on it while a `next()` is pending only queues the return; if the journal never changes again, the watch is never released. The view closes exactly in that state.

The core creates an `AbortController` per `events()` call and passes its signal in `InspectContext`. The Claude Code provider closes its tail when the signal aborts; the tail's `close()` already wakes its iterator, so the pending `next()` resolves as done and the chain unwinds. `events()` returns the iterable with a `close()` that aborts, and its iterator's `return()` aborts before delegating, so both documented ways of stopping work while waiting.

Alternative: race `next()` against a cancel promise in the CLI and abandon the iterator. Rejected: the generator and its watch would stay alive, which is the leak this is meant to avoid.

### 4. Lines are computed in `transcript.ts` and cached per `(items, cols)`
`transcriptLines(items, cols)` is pure and wraps text with the same `wrap` the detail view uses. Both the reducer (to clamp `scroll` and implement `follow`) and the renderer need the line count, so the function lives in its own module and memoizes on the identity of the `items` array and `cols` in a `WeakMap`. The reducer replaces `items` on append, so the cache invalidates itself, and a scroll keypress costs a slice, not a re-wrap.

`follow` is true while the view is at the end. Scrolling up clears it; `End` sets it. With `follow`, `scroll` is recomputed to the last page after every append and resize.

### 5. Tool failures are their own item
A `tool-result` with `isError` becomes an item `{ kind: 'tool-failed', text: <tool name> }`, using a `Map` of tool id to name kept by `run.ts` for the life of the stream. Marking the earlier `tool` item instead would mean mutating state the reducer has already handed to the renderer.

### 6. One-shot `--history` uses `sessions()`
`--once --history` and `--json --history` call `aya.sessions()` after `ready` instead of `running()`. `formatTable` sorts live sessions first by the existing rank, then the rest newest first, and prints `closed` for a session with no `pid`. JSON output needs no change beyond the input list.

### 7. Keys
`H` (history) and `t` (transcript) are free today. Lower-case `h` stays help. Inside the transcript view only scroll keys, `t`/`Esc` (close), `?`/`h` (help) and `q`/`Ctrl+C` (quit) act; the filter and sort keys are ignored there rather than changing a table the user cannot see.

## Risks / Trade-offs

- [A machine with thousands of journals makes `H` take a moment] → the header shows `loading history…`, the table stays usable, and `sessions()` reads only the head and tail of each journal.
- [A very large transcript holds all its text in memory while open] → items drop `raw`; memory is released when the view closes. Acceptable for a viewer; a windowed reader would need random access the provider contract does not offer.
- [History rows go stale while history is shown] → they are historical by definition; live rows still update from events, and `H` twice reloads.
