## 1. Scaffold and arguments

- [x] 1.1 Add `"bin": { "aya": "dist/cli/aya.js" }` to `package.json` and create `src/cli/aya.ts` with a `#!/usr/bin/env node` shebang; verify `npm run build` emits `dist/cli/aya.js` with the shebang intact
- [x] 1.2 Implement `src/cli/args.ts` (`--once`, `--json`, `--all`, `--help`, `--version`, usage error for unknown flags); verify `test/cli/args.test.ts` covers each flag and the exit-2 unknown-flag case
- [x] 1.3 Implement `--version` by reading `package.json` relative to `import.meta.url`, and `--help` usage text listing flags and keys; verify `node dist/cli/aya.js --version` prints the package version

## 2. View state

- [x] 2.1 Implement `src/cli/state.ts` `ViewState` and `applyEvent` for session create/open/status/update/activity/close, subagent start/end, `ready`, and `error`, storing plain snapshots; verify `test/cli/state.test.ts` covers header counts, close removal, closed-set retention, and last provider error
- [x] 2.2 Implement `applyKey` for selection movement (`↑↓jk`, Home/End, PgUp/PgDn), `Enter` detail, `s`/`<`/`>` sort cycle, `r` reverse, `/` filter prompt with `Enter`/`Esc`, `c` closed toggle, `?`/`h` help, `q`/Ctrl+C quit, and error dismissal; verify reducer tests for each binding
- [x] 2.3 Implement `src/cli/rows.ts` filtering (case-insensitive over title, cwd, harness, model, pid), default status-then-updated sort, reversible column sorts, and selection-by-id with nearest-row fallback; verify tests for "Default order", "Filter by cwd", "Selection follows session", and "Selected session closes" scenarios

## 3. Rendering

- [x] 3.1 Implement `src/cli/ansi.ts` (alt screen, cursor show/hide, home, SGR styles, `stripAnsi`, width-aware truncate incl. wide chars); verify unit tests for truncation and stripping
- [x] 3.2 Implement `src/cli/render.ts` producing a full frame: loading state before ready, header counts and filter `shown/total`, sort marker, width-priority column selection, `-` for unknowns, absolute times, dimmed closed rows, status line for provider errors; verify snapshot-style tests at 60, 100, and 160 columns and that no line exceeds `cols`
- [x] 3.3 Render the detail view (id, full title/cwd, kind, `waitingFor`, current tool + start time, last error, subagent list) and the help overlay; verify render tests for "Detail shows subagents" and help contents
- [x] 3.4 Implement `src/cli/table.ts` plain-text table (no escapes when not TTY or `NO_COLOR`) and JSON serialisation with the spec's field list; verify tests for "Piped output" and "JSON" with empty and populated sessions

## 4. Runtime shell

- [x] 4.1 Implement `src/cli/run.ts` one-shot path (`--once`, `--json`, non-TTY stdout): start, wait for `ready`, print, stop, return 0; verify `test/cli/run.test.ts` using `createMemoryHarness` and in-memory streams
- [x] 4.2 Implement the interactive path: enter alt screen/raw mode, wire instance events, keypresses (`readline.emitKeypressEvents`), and `resize` to state, with `queueMicrotask` redraw coalescing; verify a test that ten synchronous events produce exactly one frame write
- [x] 4.3 On detail open, fetch `session.subagents()` once and drop late results if detail closed; verify a test with memory-harness subagents
- [x] 4.4 Implement idempotent `restore()` wired to quit, `SIGINT`, `SIGTERM`, `uncaughtException`, and `unhandledRejection`, stopping the instance and returning exit 0 on quit and non-zero on error; verify tests for "Quit restores terminal" and "Crash restores terminal" assert restore sequences are written
- [x] 4.5 Verify the "Idle screen holds no timers" scenario: with `installTimerGuard`, open the TUI against the memory harness, let it settle after `ready`, and assert `assertIdle()` passes and no further frame is written
- [x] 4.6 Wire `src/cli/aya.ts` to call `run` with real process streams, `AllYourAgents`, and `process.exitCode` (not `process.exit`, which aborts while the koffi process-watch worker is still loading); verify `npm run lint` passes (including `check-no-interval`) and the CLI imports only from `../index.js` / `../testing` types, not `core/` or `providers/`

## 5. Library fix: process-watch worker shutdown

- [x] 5.1 Make the process-watch worker lazy (spawned on first watch, retired when none remain), never unref'd or terminated, and make `close()` resolve after the worker exits; `stop()` awaits it. Verify 10/10 start→stop→exit runs with no koffi abort (previously 1 in 6 aborted)
- [x] 5.2 Close the worker's port on every loop-ending path (no koffi, unsupported platform, wait error) and ignore messages after shutdown; verify `test/helpers/processes.test.ts` "close() waits for the worker" passes, spawning child processes that close at 0/5/50/200 ms

## 6. Packaging, docs, and end-to-end

- [x] 6.1 Extend `test/pack.test.ts` to run the installed `aya --version` and `aya --json` from the tarball; verify `npm test` passes with `AYA_SKIP_PACK=0`
- [x] 6.2 Add a "CLI" section to `README.md` covering `aya`, flags, key bindings, and the absolute-times/no-polling note; verify `test/types/readme.ts` still compiles
- [x] 6.3 Manually run `npm run build && node dist/cli/aya.js` with one or more real Claude Code sessions open: confirm rows appear, status changes live, resize works, `q` restores the terminal, and `node dist/cli/aya.js | cat` prints a plain table
- [x] 6.4 Run `npm run lint`, `npm run build`, and `npm test` and confirm all pass
