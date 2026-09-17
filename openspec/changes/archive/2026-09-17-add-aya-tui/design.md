## Context

`all-your-agents` exposes an event API (`AllYourAgents().on(...)`, `start()`, `running()`) with catch-up then `ready`, and forbids timers while idle (ADR 0001, enforced by `scripts/check-no-interval.mjs` over `src/` and by `installTimerGuard` in tests). The package ships ESM from `dist/`, has no runtime dependencies (only optional `koffi`), and targets Node ≥ 20 on macOS/Linux. `createMemoryHarness()` in `all-your-agents/testing` gives a scriptable provider suitable for driving a UI in tests.

## Goals / Non-Goals

**Goals:**
- Keep rendering a pure function of state so layout, sorting, filtering, and truncation are unit-testable without a terminal.
- Keep the CLI a plain consumer of the public API: it imports from `../index.js` only, never from `core/` or `providers/`.
- Hold zero timers while idle, provably, with the existing timer guard.

**Non-Goals:**
- Acting on agents (kill, focus, attach, send input), transcript viewing, mouse support, colour themes, config files, Windows.
- Diff-based partial repaint. A full-frame write per redraw is fine at this data size.

## Decisions

### Layout: `src/cli/` split into pure pieces and one impure shell
- `args.ts` — parse argv into `{ mode: 'tui' | 'once' | 'json', all, help, version }` or a usage error.
- `state.ts` — `ViewState` (sessions by id, closed set, selectedId, sort, filter, detail/help open, lastError, ready) plus `applyEvent(state, event)` and `applyKey(state, key)` reducers returning new state. Stores plain snapshots copied from `Session`, not the live objects.
- `rows.ts` — derive visible rows: filter, sort, selection resolution (keep id; if gone, nearest index).
- `render.ts` — `render(state, { cols, rows, color }) => string` producing a full frame; column set chosen by width with fixed priority (status, pid, title, cwd, tool, subagents, harness, model, last turn, updated).
- `ansi.ts` — tiny escape helpers (alt screen, cursor, clear, SGR, `stripAnsi`, width-safe truncate).
- `keys.ts` — map `readline` keypress `{ name, ctrl, sequence }` to key actions.
- `table.ts` — plain-text table and JSON serialisation for one-shot modes.
- `run.ts` — `run({ argv, stdin, stdout, stderr, env, createInstance })`: wires instance events, keypresses, resize, signals; returns exit code. Injected streams and factory make it testable with the memory harness.
- `aya.ts` — `#!/usr/bin/env node` entry that calls `run` with real process values and `process.exit`s with its code.

Alternative considered: a TUI library (ink, blessed). Rejected per the no-new-dependencies decision; ink also pulls React, and blessed is unmaintained.

### Redraw scheduling: microtask coalescing, not timers
Every event/key/resize marks state dirty and, if no flush is queued, calls `queueMicrotask(flush)`. `flush` renders once and writes one string. Microtasks are not timers, so `installTimerGuard().assertIdle()` stays green, and all events delivered synchronously in one emitter dispatch collapse into one write. Alternative: `setImmediate` — works but is a macrotask that the lint/guard reader might mistake for a timer; microtask is simpler.

### Times: absolute, not ticking
Show `updatedAt` / tool `startedAt` as `HH:MM:SS` (today) or `MMM DD HH:MM` (older). A live "running for 12s" would require a clock-driven redraw, which the user chose against. Durations can be computed at redraw moments later without spec change if ever wanted, but they would go stale between events, so we don't show them.

### Data source: events + `running()` at `ready`
On each session event store a snapshot of the passed `Session`. At `ready`, reconcile the table with `aya.running()` so catch-up ordering quirks can't leave stale rows. Subagents for the detail view come from `subagent:start`/`subagent:end` events plus one `session.subagents()` call when detail opens (a one-shot query in response to a keypress, allowed by ADR 0001). Results that arrive after the detail closes are dropped.

### Terminal handling
Enter: `\x1b[?1049h` alt screen, `\x1b[?25l` hide cursor, `stdin.setRawMode(true)`, `readline.emitKeypressEvents(stdin)`. Leave: reverse, idempotent via a `restored` flag. Install handlers for `SIGINT`, `SIGTERM`, `uncaughtException`, `unhandledRejection` that restore then exit. `stdout.on('resize')` triggers redraw. Colour when `stdout.isTTY && !env.NO_COLOR`.

### One-shot modes
`--once`/non-TTY/`--json`: subscribe to `ready`, `start()`, on ready read `running()`, print, `stop()`, return 0. No raw mode, no alt screen.

### Packaging
`package.json` gains `"bin": { "aya": "dist/cli/aya.js" }`. `tsc` preserves the shebang; `npm` sets the executable bit on install. `test/pack.test.ts` runs the installed bin with `--version` and `--json`.

### Process-watch worker shutdown (library fix)
Manual testing showed `aya` aborting on quit with a koffi `FATAL ERROR`. A plain `start()` → `stop()` script did the same, intermittently. Cause: `processes.close()` posted `stop` to the worker and returned at once, and the worker was `unref`'d, so Node could exit while the worker was loading koffi or had an async `kevent`/`epoll_wait` in flight, and koffi aborts when its environment is torn down under it.

Fix, in `src/helpers/processes.ts` and `process-watch-worker.ts`:
- The worker is spawned on the first `watch()` and retired when the last pid is unwatched or exits. While it exists it stays ref'd, so the process cannot exit underneath it.
- Retiring posts `stop`; the worker wakes its wait through its pipe, closes its fds and its port, and exits by itself. It never gets `terminate()`d.
- The worker closes its port on every path that ends its loop (koffi missing, unsupported platform, wait error), so it always exits.
- `close()` returns a promise that resolves after every retiring worker has emitted `exit`; `instance.stop()` awaits it.

Alternatives: `worker.terminate()` (the abort we are fixing), or a timer-based grace period (violates ADR 0001).

## Risks / Trade-offs

- [A consumer that never calls `stop()` while pids are watched now keeps the process alive] → consistent with other active handles; `stop()` was already the documented way to release watches.

- [Wide characters/emoji in titles break column alignment] → truncate by code points with a simple East Asian wide-range check; accept imperfection for rare glyphs.
- [Terminal left in raw/alt mode after a crash] → single idempotent `restore()` wired to every exit path; tested by asserting the restore sequence is written on thrown errors.
- [Absolute times feel less "top-like"] → trade-off accepted to keep ADR 0001; header shows the time of the last redraw so users can tell the view is live.
- [Full-frame writes flicker on slow terminals] → write the frame as one `stdout.write` starting with cursor-home rather than clear-screen.
- [`--version` needs the package version without JSON import assertions on Node 20] → read `../../package.json` via `fs.readFileSync` relative to `import.meta.url`.

## Migration Plan

Additive only. Rollback is removing the `bin` entry and `src/cli/`.
