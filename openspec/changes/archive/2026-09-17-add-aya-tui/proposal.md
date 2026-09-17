## Why

The library can watch every coding agent on the machine, but there is no way to *see* that without writing code. An `aya` command that works like `top`/`htop` gives users an instant live view of which agents are running, waiting on them, or idle, and doubles as a real consumer that dogfoods the public API.

## What Changes

- Add an `aya` executable (`bin` entry in `all-your-agents`) that opens a full-screen terminal UI listing live agent sessions.
- One row per live session: status, harness, pid, title, cwd, model, current tool, open subagents, last turn outcome, started/updated time.
- Header summary: counts by status (running / waiting / idle) and total live sessions.
- Keyboard: move selection, sort by column, filter by text, expand a row to show its subagents and `waitingFor`, toggle recently closed sessions, help overlay, quit.
- Screen redraws only in response to library events, keypresses, and terminal resize. No render clock; times are shown as absolute clock times, not ticking durations (keeps ADR 0001 intact).
- One-shot modes: `aya --once` (and automatically when stdout is not a TTY) prints a plain-text table after `ready` and exits; `aya --json` prints the snapshot as JSON and exits.
- Zero new runtime dependencies: rendering uses raw ANSI escapes and `node:readline`/`node:tty`.

## Capabilities

### New Capabilities
- `aya-cli`: the `aya` command — live TUI monitor of agent sessions, its keyboard controls, event-driven redraw, and one-shot text/JSON output modes.

### Modified Capabilities
<!-- None: the CLI consumes the existing agent-sessions API without changing its requirements. -->

## Impact

- `package.json`: new `bin` field (`aya` → `dist/cli/aya.js`); `files` already ships `dist`.
- New code under `src/cli/` (argument parsing, view state, layout/renderer, key handling, entry point).
- Library fix found while building the CLI: `stop()` could abort the host process (koffi fatal error) because it did not wait for the process-watch worker to exit. `createLocalProcesses().close()` now resolves only after the worker has exited, the worker runs only while a pid is watched, and `stop()` awaits it. No public API change beyond `close()` returning a promise.
- Lint: `scripts/check-no-interval.mjs` already scans `src/`, so the CLI inherits the no-`setInterval` rule.
- Tests: new unit tests under `test/cli/` driven by `createMemoryHarness`; `test/pack.test.ts` extended to check the installed `aya` bin runs.
- README: short "CLI" section.
- Platforms: macOS and Linux terminals, Node ≥ 20 (same as the library).
