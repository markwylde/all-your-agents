## 1. Project setup

- [x] 1.1 Rewrite `package.json`: ESM, `engines.node >=20`, `exports` for `.` and `./testing`, scripts `build`/`test`/`lint`. Add `typescript`, `@types/node`, and `@biomejs/biome` as dev dependencies. Verify `npm install` succeeds.
- [x] 1.2 Add `tsconfig.json` (strict, NodeNext, `outDir: dist`), `biome.json`, and `.gitignore`. Verify `npm run build` and `npm run lint` pass on an empty `src/index.ts`.
- [x] 1.3 Wire `npm test` to build, then run `node --test dist-test/**/*.test.js` (or `--experimental-strip-types`). Verify a placeholder test runs and passes.

## 2. Types and provider contract

- [x] 2.1 Define `Harness`, `SessionStatus`, `Session`, `SessionSnapshot`, `EventMeta`, and the query filter including `since` and `kind`. Verify with type tests (`tsc --noEmit` on a usage file).
- [x] 2.2 Define normalized `SessionEvent` kinds (`user`, `assistant`, `tool`, `tool-result`, `title`, `turn-end`, `subagent`, `subagent-end`, `error`, `other`), each with `raw` and optional `at`. Verify with type tests.
- [x] 2.3 Define `SessionActivity`, `Subagent`, `SubagentStatus`, `kind`, and the turn/subagent fact types providers emit. Verify with type tests.
- [x] 2.4 Define `Provider`, `WatchContext` (`emit`, `home`, `fs`, `processes`, helpers), `ListContext` (with `since`/`id` hints), and `InspectContext`. Verify with a type test that a minimal custom provider compiles.
- [x] 2.5 Define the injectable `Fs` (`readFile`, `readRange`, `readDir`, `stat`, `watch`) and `Processes` (`info`, `watch`) interfaces, the `Turn` type, and the `TitleSource` union. Verify with type tests.

## 3. Watch helpers

- [x] 3.0 Implement `coalesce(quietMs, maxLatencyMs)`: per-path trailing debounce with a latency ceiling, timer armed only between a notification and its serviced read. Verify with a fake clock: 100 notifications in 200 ms → 1 read; 30/s for 10 s → about 10 reads; 1 notification → read at 25 ms; idle → no pending timer.
- [x] 3.1 Implement the local `Fs` and `watchDir` on top of `coalesce`: initial scan, create/change/delete decided by existence, and missing-directory ancestor watching. Verify with temp-directory tests for create, atomic rename-over, delete, directory created later, and that a change to one of fifty entries reads only that entry.
- [x] 3.2 Implement `watchFile`. Verify change and delete tests pass.
- [x] 3.3 Implement `tailJsonl` with offset, partial-line buffer, truncation reset, watch-before-read, coalesced reads, and close on iterator return. Verify tests for partial lines, appends during replay, truncation, `break` releasing the watcher, and 30 appends/s yielding every line in order with about one read per second.
- [x] 3.4 Implement local `processes.info` for macOS (`ps -o lstart=` with `LC_ALL=C`) and Linux (`/proc/<pid>/stat` + btime). Verify the current process's start time falls within a few seconds of `Date.now() - process.uptime()*1000`, and that a dead pid reports `alive: false`.
- [x] 3.5 Implement local `processes.watch` with `koffi` (optionalDependency): macOS `kqueue`/`EVFILT_PROC`/`NOTE_EXIT`, Linux `pidfd_open` + `epoll`, one Worker per instance running the blocking wait, `unsupported` when `koffi` fails to load. Verify a detached `sleep` not spawned by the test triggers `onExit` within 50 ms of exiting, `stop()` ends the Worker, no timer is armed, and with `koffi` stubbed out the result is `unsupported`.
- [x] 3.6 Add a no-timers test utility that fails on any pending `setTimeout`/`setInterval` during an idle window, and a lint rule banning `setInterval` outside `helpers/coalesce.ts`. Verify it fails on a deliberate timer and passes on idle helpers.

## 4. Core

- [x] 4.1 Implement the live registry: per-id ordering, status/metadata dedupe, `pid` cleared on close, `running()`. Verify with unit tests driven by a scripted in-memory provider.
- [x] 4.2 Implement `start()`/`stop()`: idempotent, catch-up with `catchUp: true`, `ready` once all `watch()` promises resolve, unwatch everything (files and processes) on stop, and `{ fs, processes, debounce }` options threaded into every provider context. Verify against spec scenarios for repeated start, no sessions, stop releasing everything, and a fake `fs` receiving every read.
- [x] 4.2a Implement `reconcile(pid?)`: one-shot re-validation of one or all live sessions via the provider's `revalidate` hook, never scheduling. Verify a dead pid closes and a live one emits nothing.
- [x] 4.2b Implement title precedence in the live registry (`user` > `harness` > `process` > `prompt`) with `session:update` only on effective-title change. Verify table tests for each override order.
- [x] 4.3 Implement provider failure isolation with the `error` event. Verify with a test where one provider throws and the other still emits and `ready` fires.
- [x] 4.4 Implement `sessions(filter)` merging live and listed sessions by id, with `harness`/`cwd`/`live`/`kind`/`since` filters and working without `start()`. Verify with unit tests for each filter.
- [x] 4.5 Implement `get(id)` and attach `transcript()`/`events()` to sessions via provider `inspect`, with `transcript()` grouping events into `Turn`s. Verify with in-memory provider tests, including two prompts → two completed turns.
- [x] 4.6 Implement the pure activity reducer (turn start clears error, tool start/finish, turn end completed/failed/interrupted, silent replay mode). Verify with table tests for done vs never-ran, error standing through idle, and replay emitting one activity.
- [x] 4.7 Implement the subagent registry: start dedupe, end at most once, end-without-start ignored, `openSubagents`, cancel on session close before `session:close`, catch-up of running subagents before `ready`, `session.subagents()`. Verify with in-memory provider tests for each scenario.
- [x] 4.8 Add a neutrality test that fails if any file under `src/core/**` imports `providers/` or contains `.claude`, and if any file under `src/providers/**` imports `node:fs` or `node:child_process`. Verify it passes, and fails when a violation is introduced.

## 5. Conformance kit

- [x] 5.1 Define the fixture driver interface (create live session, rewrite status, switch conversation, update metadata, remove, add journal, run a turn with a tool, fail a turn, launch/finish a foreground or background subagent, launch a nested subagent) and export the kit from `all-your-agents/testing`. Verify it compiles and the export resolves.
- [x] 5.2 Implement the cases: catch-up/ready, create vs open, status dedupe, switch = close + open, close keeps history, stop releases, no timers while idle, burst coalescing and ceiling, process exit via `processes.watch` and via `reconcile`, journal relocation, title precedence, activity (tool, completed, failed standing through idle), subagents (start, end, nested, background outliving turn, cancel on close, catch-up). Verify all pass against the in-memory provider.

## 6. Claude Code provider

- [x] 6.1 `paths.ts`: home from option, then `CLAUDE_CONFIG_DIR`, then `~/.claude`; non-alphanumeric → `-` encoding; derived journal path. Verify with table tests, including `.claude/worktrees` paths and the env override.
- [x] 6.2 `session-file.ts`: allowed-field parse, size bound, pid/filename match, UUID check, ±5 s start-time check with an unknown-start fallback. Verify tests for recycled pid, pid mismatch, 4 s accept, 6 s reject, malformed JSON, and oversized file.
- [x] 6.3 `status.ts`: busy/waiting/idle/shell mapping, with unknown words leaving status absent. Verify with table tests.
- [x] 6.4 `journal.ts`: bounded journal resolution (derived path, then a one-level lookup, ambiguity → none, header must prove id and not be a sidechain) and the pure record mapper including `custom-title`, `agents_killed`, and the full unmapped list (`queue-operation`, `relocated`, `worktree-state`, `bridge-session`, `file-history-delta`, compaction and hook summaries, unknown types). Verify tests for resumed-from-another-dir, two dirs with the same id, sidechain rejection, and mapper tables including system-reminder, task-notification, queue-operation, and command-metadata exclusions.
- [x] 6.5 `provider.ts` `watch`: watch `sessions/`, bind on accept, `processes.watch` per bound pid, decide create vs open at bind, rewrite diffing (switch → close + open without carried state; status and cwd in one write both reported; `name` fed as `process` title source), unlink → close, exit event → close and mark stale, `revalidate` on `sessions/` sibling events and on `reconcile` when exit watching is unsupported, missing home watched via ancestor. Verify with provider tests using fake `processes` and a temp home for every spec scenario, including two sessions in one cwd, kill -9 with the file left behind (both exit-event and reconcile paths), a stale file rewritten by a new process, a fake clock advancing with no close, and a key sibling that is never opened (spy on `fs.readFile`).
- [x] 6.5a Journal relocation: on same-id cwd change, re-resolve the journal, swap the tail and `subagents/` watch, silent replay with the `statusUpdatedAt` cutoff. Verify a worktree-move test emits `session:update` only, tails the new path, and re-opens no finished subagent, and a not-yet-moved test keeps the old tail.
- [x] 6.6 `activity.ts`: map journal records to turn facts (prompt, tool_use/tool_result, `turn_duration`/`end_turn`, `isApiErrorMessage`, `[Request interrupted by user`), close an open turn when the session file goes idle, silent replay at bind with the `statusUpdatedAt` cutoff, task notifications never start turns. Verify tests for a turn without turn_duration, API error then idle, 40-turn replay emitting once, bind to idle mid-tool yielding no open tool, and a task notification not clearing an error.
- [x] 6.7 `subagents.ts`: toolUseId map from `Agent`/`Task` tool uses and `meta.json`; type/title/background/parentId; foreground end via `tool_result` (`is_error` → failed); background end via task notification `<tool-use-id>`/`<status>` (killed/stopped → cancelled); `agents_killed` → all open cancelled; ignore unknown tool-use ids; cancel foreground on idle; interruption in child journal → cancelled; watch `subagents/` and tail open child journals for nesting. Verify tests for every Subagent lifecycle scenario, including meta file before tool use yielding one start and a Bash notification yielding nothing.
- [x] 6.8 Headless: read `kind`/`entrypoint`, mark journals with non-`cli` entrypoint as `headless` in listing, never emit live events without a session file. Verify with a print-mode fixture listed via `sessions({ since, kind: 'headless' })`.
- [x] 6.9 `list.ts`: root journals only, head/tail bounded metadata (cwd, title by precedence, startedAt, updatedAt), `since` short-circuit on mtime, `id` hint. Verify tests for subagent exclusion, custom-title over ai-title over prompt, and a large journal read without a full parse.
- [x] 6.10 `inspect`: `transcript()` replays mapped events, and `events()` tails the resolved journal, for both sessions and subagents; `session.subagents()` for history reads `subagents/*.meta.json` and the root journal. Verify a test appending to a journal yields a new `user` event, `break` closes the watcher, and a closed session's subagents all have final statuses.
- [x] 6.11 Write a Claude Code fixture driver and run the conformance kit against the provider. Verify all cases pass.

## 7. Real-world fixtures

- [x] 7.1 Capture one real 2.1.x session file, a multi-turn journal with a foreground subagent, a background subagent with its task notification and `meta.json`, an API-error turn, an interrupted turn, a `custom-title`, an `agents_killed`, a `relocated` journal with its pre- and post-move paths, a `queue-operation` carrying a task notification, and an `sdk-cli` headless journal. Scrub prompt/response text and check them in under `test/fixtures/claude-code/2.1/`. Verify no personal content remains (grep for home path and prompt text).
- [x] 7.2 Add expected-output snapshots for mapping, activity, subagents, and listing of the captured fixtures, plus a compat test asserting the documented allowed field set. Verify the tests pass.

## 8. Packaging and docs

- [x] 8.1 Export `builtInProviders`, a default `AllYourAgents`, a named `claudeCode(options)` factory, and types from `src/index.ts`. Verify with a packed test: `npm pack`, install into a temp dir, import both entry points under ESM.
- [x] 8.2 Update the README: link ADR 0001, `since`/`kind` filters, `Turn`/`SessionEvent` types, `activity` and `session:activity`, subagents and `subagent:*` events, the encoding rule, the `error` event, `reconcile`, `{ fs, processes, debounce }` options, `CLAUDE_CONFIG_DIR`, title precedence, and the testing kit. Verify README code samples compile via a doc-snippet type check.
- [x] 8.3 Add an opt-in live smoke test (`AYA_LIVE=1`) that starts `claude`, launches a subagent, waits for create → status → subagent:start → subagent:end → activity completed → close, and runs `sessions({ since: startOfToday })`. Verify it passes locally and is skipped by default.
- [x] 8.4 Add a CI workflow running lint, build, and test on macOS and Ubuntu with Node 20 and 22. Verify it is green on both.
