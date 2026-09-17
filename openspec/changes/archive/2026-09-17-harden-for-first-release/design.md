## Context

See proposal.md for motivation. The constraints that shape the fixes:

- ADR 0001: no timers while idle. Nothing below may add one. `queueMicrotask` is not a timer and is already used by the CLI.
- Nothing is published yet, so names and error shapes can still change without a migration path.
- Providers only ever see a `WatchContext` built by the core. `tailJsonl`, `watchDir` and `emit` on it are the core's own helpers, so changing them changes every provider at once.
- The Claude Code journal can be hundreds of MB. Today a bind reads it fully into memory, parses it, then `tailJsonl` reads and parses it again from byte 0 and the provider discards that many records by count.

## Goals / Non-Goals

**Goals:**
- Every defect from the review fixed at its cause, with a test that fails before the fix.
- No new dependency, no new timer, no new public surface beyond what a fix needs.

**Non-Goals:**
- TUI history browsing and a transcript view (separate change).
- Streaming the bind replay so a journal is never held in memory at once. One read instead of two is the fix here; the replay still holds the parsed records while it folds them.
- Disambiguating equal session ids across providers. `sessions()` still merges by id, as specified.

## Decisions

### 1. One bin, named after the package
`bin: { "all-your-agents": "dist/cli/main.js" }`, and `src/cli/aya.ts` becomes `src/cli/main.ts`. `npx <pkg>` runs the bin whose name equals the package name, so this is the only name that works without a prior install.

Alternative: keep `aya` as a second bin for people who install globally. Rejected: it would shadow or be shadowed by the unrelated `aya` package on the same machine, and two names for one command is a support cost for no real gain. A user who wants it short can alias it.

The OpenSpec capability stays `aya-cli`; capability paths are identifiers, not user-facing names, and renaming one would orphan the archive history.

### 2. Build on `prepack`, not `prepublishOnly`
`prepack` runs for both `npm pack` and `npm publish`, so the tarball the pack test installs is built the same way as the one that ships. `prepublishOnly` would leave `npm pack` able to produce an empty tarball.

`repository` is left unset: the repo has no remote yet, and a guessed URL is worse than none. `author` is set from the git identity (name only).

### 3. `error` payload is a union discriminated by `source`
```ts
type AgentsError =
  | { source: 'provider'; provider: string; error: unknown }
  | { source: 'listener'; event: string; error: unknown };
```
A listener failure is not a provider failure, and pretending it is (`provider: 'listener'`) would make consumers string-match. `ProviderError` is removed rather than kept as an alias; nothing is published, and the unused `path` field goes with it.

### 4. Listener isolation lives in the core's `emit`
Each listener call is wrapped. On a throw the core emits `error` with `source: 'listener'`. If there is no `error` listener, or the throw came from an `error` listener, the error is rethrown from `queueMicrotask`, which surfaces as `uncaughtException` with the original stack.

Alternatives considered:
- Swallow silently: hides user bugs; this is how the current defect stayed invisible.
- Let it propagate: the throw unwinds through `ctx.emit` into provider code, which is what ends the journal tail today.
- Node `EventEmitter` semantics (throw synchronously when `error` has no listener): same unwinding problem.

### 5. `ctx.reportError` for failures after `watch()` returns
`makeWatchCtx` becomes per-provider so the report can be attributed. The Claude Code tail loops wrap each record: a failure is reported and the loop continues. A failure of the tail iterator itself (the fs rejected) is reported once and ends that tail, unless the provider is closing.

Alternative: let the core wrap `tailJsonl` iteration. Rejected: the core cannot know which callback belongs to which record handler, and custom providers with their own loops would still need a channel.

### 6. History routing carries the provider id, not a lookup
`transcriptFor`, `eventsFor` and `subagentsFor` take `(providerId, sessionId, subagentId?)`. Sessions built from live entries, history entries and list snapshots all already know their provider id, so the `live.get(id) ?? history.get(id)` lookup and the `?? providers[0]` fallback are both deleted. `SubRecord` keeps its session's provider id for the same reason.

### 7. One session builder
`attachSession` is the only place a `Session` is assembled from a `LiveEntry`. `snapshotToSession` loses its `live` branch (it produced `undefined`-valued keys and shared the mutable `activity`), and `sessions()` is reduced to: history entries, then list snapshots that are not live, then live entries, each filtered once.

### 8. `tailJsonl` backlog option
`tailJsonl(fs, path, { backlog: 'separate' })` returns a handle whose `backlog: Promise<unknown[]>` resolves after the first read with the records found, and whose iterator yields only what is appended later. Without the option, `backlog` resolves to `[]` and iteration yields everything, as today.

An option fixed at creation, rather than a method called later, removes the race between the first read finishing and the caller asking for the backlog.

Alternative: expose a byte offset so the provider reads the file itself and then tails from there. Rejected: the offset must be taken at a line boundary and atomically with the read, which is exactly what the tail already does internally.

The provider then seeds from `await tail.backlog` and handles iterated records as live. The count-based `skipping` is deleted.

### 9. Streaming UTF-8 decode in the tail
The tail owns a `TextDecoder` and decodes with `{ stream: true }`; truncation resets it. The shared stateless `decodeUtf8` stays for whole-file reads.

### 10. `watchDir`: watch, then scan; rebind when the directory goes away
Order becomes `fs.watch(dir)` → `readDir` → report. The scan skips names the event path has already registered, so a racing entry is reported once. `fs.watch` failing (directory vanished between `stat` and `watch`) falls back to the ancestor watch, as `readDir` failing already does.

When servicing an event finds the entry gone, the helper also stats the directory. If it is gone: report a delete for every known entry, close the handle, and `bind(path)` again, which walks up to the nearest existing ancestor. This costs one extra `stat` per deleted entry and no timer.

### 11. Model comes from assistant records
`turnFactsFromRecord` stays about turns. A small `modelOf(record)` in `journal.ts` returns `message.model` for assistant records, ignoring `<synthetic>`. The live path emits `session:update { model }` per root assistant record (the core already dedupes), the seed path emits the last one once, and `list` takes the last one found in the tail window it already reads.

### 12. Bounded closed-session memory
`history` is a `Map`, which iterates in insertion order. On close, the entry is inserted; while `history.size > 1000` the first key is evicted along with its `titles` and `subagents`. Re-opening a session removes it from `history` first, so order reflects most recent close. 1000 is a constant, not an option: entries are a few hundred bytes, and a knob nobody needs is API surface to maintain.

`stop()` forgets live entries with their titles and subagents. Today it clears `live` only, so after a restart the provider's `subagent:start` is dropped as a duplicate.

### 13. Cleanups ride along only where the fix touches the code
Removed: `staleFiles`, `Bound.stale`, `Bound.activity`, the empty `else if` in `handleRecord`, the no-op `system` subtype chain in `mapRecord`, `void toolResultText`, and the duplicate `contentOf`/`textOf` in `activity.ts` (exported from `journal.ts` instead). Stale files need no bookkeeping: `parseSessionFile` already rejects a file whose process is dead.

### 14. Session file events run through a per-file queue
Found while fixing the leaked watches: `bind` awaits the filesystem, and the watcher started a new task per event, so a rewrite or removal of the same file could overtake a bind in progress. That bound one session twice or brought a removed one back, each time leaving watches behind (the intermittent test-process hang). The provider now chains the work for each session file path on a promise, and every attach re-checks `bound.released` after an await. A failure inside a queued task goes to `ctx.reportError`. The unbounded `pending` array of settled promises goes away with it.

Alternative: keep events concurrent and re-validate after every await. Rejected: every new await becomes a new place to forget the check; ordering removes the class.

### 15. `stop()` waits for a `start()` in flight
`start()` hands its unwatch functions over only when each provider's `watch()` resolves, so a `stop()` that ran in between released nothing. `stop()` now marks the instance closed immediately (events stop), awaits the start, then unwatches. `start()` after that awaits the stop.

### 16. Live sessions get a `prompt` title
`list` derived a title from the first prompt; the live path never did, so the same session had a title in history and none while live. Both now share `promptTitle()`.

## Risks / Trade-offs

- [`prepack` makes `npm test` rebuild `dist` inside the pack test] → `dist` is only read by that test and the e2e suite; the rebuild is idempotent.
- [Rethrowing a listener error as an uncaught exception can end a consumer's process] → only when they registered no `error` listener, and that is the point: the bug is theirs and must be visible. The CLI registers one.
- [An extra `stat` of the directory on each deleted entry] → one syscall in direct response to a notification, allowed by ADR 0001.
- [Evicting closed sessions changes `get()` for a watch-only provider after 1000 closes] → specified; providers with `list` are unaffected.
- [Renaming the `error` payload breaks anyone on a git install] → nothing is published.
- [macOS: an established `fs.watch` can drop an event when another watch opens or closes at that moment] → Measured here at 6 dropped of 200 under adversarial timing, 0 of 200 without churn. libuv serves all watches from one FSEvents stream and rebuilds it on every change. A dropped session-file rewrite leaves a status stale until the next rewrite. Out of scope for this change because it needs a design decision consistent with ADR 0001 (for example re-statting watched entries once, in response to the library's own "a watch was opened" event, or kqueue vnode watches through the existing optional `koffi`). The tests wait 50 ms after opening watches before writing, as the existing helper tests already did.
