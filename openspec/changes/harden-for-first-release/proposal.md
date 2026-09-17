## Why

A pre-release review found defects that would reach the first users: the documented `npx aya` command runs an unrelated npm package, the MODEL column is always empty, a throwing event listener silently ends a session's live updates, and transcript lookups are routed to the first provider rather than the one that owns the session. Fixing them before 1.0.0 is cheaper than fixing them after the names and error shapes are public.

## What Changes

- **BREAKING** The executable is renamed from `aya` to `all-your-agents`, so `npx all-your-agents` resolves to this package. No `aya` bin is installed. Error prefixes, usage text, README and the pack test follow.
- Packaging: the tarball is always built before it is packed (`prepack`), and `author` is filled in.
- The Claude Code provider reports `model` for live sessions from the journal's assistant records, and `list` includes it on history snapshots.
- **BREAKING** A listener that throws no longer propagates into the provider that caused the event. It is reported on `error` as `{ source: 'listener', event, error }`. Provider errors become `{ source: 'provider', provider, error }`. A listener failure with no `error` listener is rethrown asynchronously rather than lost.
- Providers get `ctx.reportError(error)` for failures that happen after `watch()` has returned. The Claude Code provider uses it so a bad record is reported and skipped, and the journal tail keeps running.
- `transcript()`, `events()` and `subagents()` are routed to the provider that produced the session. There is no fallback to the first provider.
- Binding a live session reads its journal once. `tailJsonl` can hand over the records already in the file separately from later appends.
- `tailJsonl` decodes UTF-8 across read boundaries, so a multi-byte character split between two reads is not corrupted.
- `watchDir` starts watching before its initial scan, so an entry created during the scan is not missed, and re-arms when the watched directory is removed and created again.
- `stop()` followed by `start()` behaves like a fresh instance for live sessions: running subagents are caught up again.
- The memory held for closed sessions is bounded.
- Cleanups with no behavior change: unused provider state (`staleFiles`, `Bound.stale`, `Bound.activity`), empty branches, duplicated record helpers, and dead merge logic in `sessions()`.

Out of scope: history browsing and a transcript view in the TUI. That is a feature, not a fix, and gets its own change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `aya-cli`: the executable name changes to `all-your-agents`; every requirement that names the command is updated.
- `agent-sessions`: `model` joins the session shape; listener failures are isolated; history reads go to the owning provider; restart after `stop()` and bounded closed-session memory are specified; the `error` payload gains `source`.
- `harness-providers`: providers can report asynchronous failures; `watchDir` watches before scanning and survives directory re-creation; `tailJsonl` offers a separate backlog and decodes across read boundaries.
- `claude-code-provider`: live `model` from the journal; `model` in history snapshots; one journal read per bind; bad records are reported, not fatal to the tail.

## Impact

- `package.json` (`bin`, `scripts.prepack`, `author`), `README.md`, `src/cli/aya.ts` → `src/cli/main.ts`, `src/cli/args.ts`, `src/cli/run.ts`, `test/pack.test.ts`, `test/cli/*`.
- Public types: `ProviderError` is replaced by `AgentsError` (a union discriminated by `source`); `WatchContext` gains `reportError`; `TailJsonlFn` gains a backlog option.
- `src/core/instance.ts`, `src/helpers/tail-jsonl.ts`, `src/helpers/watch-dir.ts`, `src/providers/claude-code/{provider,journal,activity,list}.ts`, `src/testing/{memory,kit}.ts`.
- No new dependencies. ADR 0001 (never poll) still holds: nothing here adds a timer.
