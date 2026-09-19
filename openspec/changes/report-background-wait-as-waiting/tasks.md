## 1. Claude Code

- [x] 1.1 Map `shell` to `waiting` / `waitingFor: shell` in `status.ts`, emit the mapped `waitingFor` at bind and on rewrite in `provider.ts`; verified by `test/providers/claude-code/status.test.ts` ("status mapping table") passing
- [x] 1.2 Add a provider test in `test/providers/claude-code/provider.test.ts` that rewrites the session file `busy` → `shell` → `busy` → `idle` and asserts the `session:status` sequence `running`, `waiting:shell`, `running`, `idle`
- [x] 1.3 Add a provider test that goes `busy` → `shell` → `idle` with a finished journal turn and asserts one turn end: `lastTurn` `completed` at the `shell` write, `lastTurnEndedAt` unchanged at the `idle` write, one `session:activity` for the end
- [x] 1.4 Add a provider test that binds to a file already in `shell` and asserts the catch-up status is `waiting` with `waitingFor` `shell`, and that replay still uses `statusUpdatedAt` as the cutoff
- [x] 1.5 Add a provider test that a foreground subagent is cancelled and a background one stays `running` at the `shell` write, and that a background agent alone with word `idle` reports `idle`
- [x] 1.6 Teach `src/testing/claude-driver.ts` a background-wait step (writes `shell`); verify through the conformance case in 5.1

## 2. Grok Build

- [x] 2.1 Add `updatesPath` to `paths.ts` and a reader that keeps only `_x.ai/session/update` rows of type `background_tasks` and `task_completed`, skipping other lines before parsing; verify with a unit test covering snapshot, completion, chunk rows ignored, and a `background_tasks` row without `tasks` reported as a record failure
- [x] 2.2 Hold the running-task map in `EventsState` and make `deriveStatus` return `waiting` with `monitor` / `shell` only when no turn is open; verify by extending "status from events" in `test/providers/grok-build/status.test.ts` with: monitor after `turn_ended`, `bash` after `turn_ended`, both running gives `monitor`, task running inside an open turn gives `running`, permission prompt unaffected
- [x] 2.3 Read `updates.jsonl` once at bind and tail it with the shared debounce, tolerate it being absent and pick it up when it appears, release the watch on close; verify with provider tests: bound while a monitor runs emits `waiting:monitor` with no `idle` first, no file behaves as before, the watch count returns to baseline after close
- [x] 2.4 Run the turn-end side effects (`endForeground`) when the turn closes rather than when status is `idle`; verify with a subagents test where a foreground child is cancelled and a background child survives a turn end that lands on `waiting`
- [x] 2.5 Add provider tests for the live transitions: `turn_started` while `waiting:monitor` gives `running` with no `waitingFor`; the last task reported `failed` with no turn open gives `idle`; a later snapshot replaces an earlier one
- [x] 2.6 Add a trimmed real-session fixture (`task_backgrounded`, `background_tasks`, `task_completed`, `turn_completed`, a few chunk rows) under `test/fixtures/grok-build/` and a compat test that the reader handles every row in it without a failure
- [x] 2.7 Teach `src/testing/grok-driver.ts` a background-wait step (appends the snapshot rows, then `turn_ended`); verify through the conformance case in 5.1

## 3. oh-my-pi

- [x] 3.1 Parse background bash jobs in `journal.ts`: open on `details.async` with `state: running`, `type: bash`; close on `async-result` `details.jobs[]`, on a result listing the job with a final status, and on `session_exit`; verify with mapper tests in `test/providers/oh-my-pi/events.test.ts` using the real row shapes, including `type: task` opening nothing
- [x] 3.2 Hold `openJobs` in `EventsState` and make `deriveStatus` return `waiting` / `shell` when no turn is open and a job is open; verify by extending "status follows the last conversation record" with: job then stop gives `waiting:shell`, `ask` inside a turn still gives `waiting:ask`, two jobs with one reported stays `waiting`
- [x] 3.3 Drop jobs started before the bound process at bind, alongside the existing stale-turn handling; verify with a provider test that binds to such a transcript and gets `idle`
- [x] 3.4 Keep `markBackground` tied to the turn closing, not to `idle`; verify with a subagents test where a child outlives a turn that lands on `waiting`
- [x] 3.5 Add provider tests for the live transitions: `async-result` then a reply gives `running` then `idle`; a `hub` result closing the job then a stop gives `idle`
- [x] 3.6 Teach `src/testing/omp-driver.ts` a background-wait step; verify through the conformance case in 5.1

## 4. Codex CLI

- [x] 4.1 Add a test to `test/providers/codex-cli/status.test.ts`: a rollout with a unified-exec `exec_command` function call followed by `task_complete` reports `idle` and never `waiting`; no source change

## 5. Shared

- [x] 5.1 Add a conformance case to `src/testing/kit.ts` ("background wait is waiting, then running when woken, then idle"), run for claude-code, grok-build and oh-my-pi and declared unsupported for codex-cli; verify the kit tests pass for all four drivers
- [x] 5.2 Add a core test in `test/core/` that `waitingFor` `shell` survives `session:status`, `get()` and `list()`, and is removed when status becomes `idle`
- [x] 5.3 Add CLI tests (`test/cli/render.test.ts`, `test/cli/state.test.ts`) that a `waiting` / `shell` row counts under `waiting` and its detail shows `Waiting for shell`
- [x] 5.4 Update README: Claude status line (done), Grok status line and its never-opened file list (remove `updates.jsonl`, describe the task rows), omp status line, Codex note, and a short "two kinds of waiting" paragraph with the `waitingFor` check; verify `npm run lint` passes and the compatibility SVG script still runs
- [ ] 5.5 Run `npm run lint` and `npm test` twice in a row with zero failures, then `openspec validate report-background-wait-as-waiting --strict`
- [x] 5.6 Check against the live machine: with a Grok monitor running after a turn and a Claude session in `shell`, `aya` shows both as `waiting`
