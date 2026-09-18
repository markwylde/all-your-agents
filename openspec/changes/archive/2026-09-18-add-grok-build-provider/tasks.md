## 1. Wiring and neutrality

- [x] 1.1 Extend the neutrality test so `src/core/**` also fails on `.grok` or `GROK_HOME`. Verify it still passes, and fails when a core file is given a `.grok` string.
- [x] 1.2 Add `src/providers/grok-build/` with a `grokBuild(options)` factory returning a `Provider` (`id` `grok-build`, `harness` `Grok`) that implements empty `watch`/`list`/`inspect`. Export it from `src/providers/grok-build/index.ts`. Verify a type test imports it.
- [x] 1.3 Change `watchFile` to always watch the parent directory filtered by filename (ancestor walk if the parent is missing), never `fs.watch` on the file inode. Verify a test that writes a temp sibling and renames it over the target twice reports both rewrites, a sibling write is ignored, and the existing change/delete test still passes.

## 2. Paths and live index

- [x] 2.1 `paths.ts`: home from option, then `GROK_HOME`, then `~/.grok`; percent-encode every character except `A-Za-z0-9-._~`; derived session dir; long names skip derive. Verify table tests for `/Users/me/app` → `%2FUsers%2Fme%2Fapp`, `/tmp/foo(bar)!` → `%2Ftmp%2Ffoo%28bar%29%21`, the env override, a custom `home`, and a cwd whose encoding exceeds 255 bytes not using the URL form.
- [x] 2.2 `index-file.ts`: parse `active_sessions.json` as an array, size bound, allowed fields only (`session_id`, `pid`, `cwd`, `opened_at`), UUID check, `opened_at >= processStart - 5s` with unknown-start fallback and no upper bound. Verify tests for recycled pid (old `opened_at` vs new process), 60 s after start accept, 4 s before start accept, 6 s before start reject, malformed JSON, oversized file, and a non-array document.
- [x] 2.3 Confirm lock/tmp/auth/sqlite paths are never passed to `fs.readFile` in a spy test once watch exists (task 4.1). Until then, add a unit that the parser ignores extra fields and does not require them.

## 3. Status, events, and chat history mapping

- [x] 3.1 `status.ts`: map `waiting_for_model` / `streaming_text` / `streaming_reasoning` / `tool_execution` → `running`; `permission_prompt` → `waiting`; after `turn_ended` or no open turn → `idle`; unknown phase omits status. Verify table tests including MCP-only logs staying idle.
- [x] 3.2 `events.ts`: pure reducer over `events.jsonl` records producing status, `waitingFor` from the latest `permission_requested`, and turn facts (`turn_started`, `tool_started`/`tool_completed`, `turn_ended` outcomes). Verify tests for permission waiting, `turn_ended` `error` → failed with no message, `cancelled` → interrupted, and `tool_started` id falling back to `tool_name`.
- [x] 3.3 `journal.ts`: bounded session-dir resolution (derived path, then one-level lookup, ambiguity → none) and the pure `chat_history.jsonl` mapper. Verify tests for resumed-from-another-dir, two dirs with the same id, `.cwd` recovery on a fixture hash dir, system-reminder exclusion, duplicate `prompt_index`, `<user_query>` inner text, `reasoning`/`system` unmapped, and `spawn_subagent` → `subagent`.

## 4. Watch, bind, and lifecycle

- [x] 4.1 `provider.ts` `watch`: `watchFile` on `active_sessions.json`; if `<home>` is missing, `watchDir` on `<home>` until the file exists, then switch to `watchFile`. Bound map keyed by `session_id`. Diff: add → bind, remove → close, cwd change → relocate. Conversation switch is remove A + add B. Bind: validate, one bounded `summary.json` read for `session_kind` (subagent entries are not roots), `watchProcess` refcounted per pid, create vs open from session-dir existence, tail `events.jsonl` and `chat_history.jsonl`, `watchFile` `summary.json`, `watchDir` `subagents/`. Verify provider tests with fake `processes` and a temp home for two sessions in one cwd, two sessions sharing one pid, lock/tmp/auth never read (spy), missing home then file created, conversation switch as close then open without carrying state, a subagent `session_kind` in the index not emitted as a root, clean index removal of one of two same-pid sessions leaving the other live, kill -9 closing every session of that pid (exit event and `reconcile` paths), stale entry rewritten by a new process, and a fake clock advancing with no close.
- [x] 4.2 Relocation: on same-id cwd change, re-resolve the session dir, swap tails and the `subagents/` watch, silent replay. Verify a worktree-move test emits `session:update` only, tails the new path, and re-opens no finished subagent, and a not-yet-moved test keeps the old tails.
- [x] 4.3 Index events serviced in order: a rewrite or removal during bind cannot overtake it; stop during bind leaves no watches. Verify the three spec scenarios (entry removed while binding, process exits while events backlog is read, stopped while binding).

## 5. Activity, model, titles, subagents

- [x] 5.1 `activity.ts`: map event records to turn facts; close an open turn when derived status becomes idle; silent replay at bind; `turn_ended` `error` sets `lastTurn` failed and takes `activity.error` from a matching chat-history error record when present, otherwise omits it. Verify a 40-turn replay emits one `session:activity`, bind to idle mid-tool yields no open tool, MCP init does not start a turn, a failed turn with no chat-history error has no `activity.error`, and a failed turn with chat-history error text keeps that error until the next `turn_started`.
- [x] 5.2 Model and titles: `current_model_id` at bind, then `turn_started.model_id` / assistant `model_id`; `title_is_manual` → `user`, else `generated_title` → `harness`, first real prompt → `prompt` (200 chars). Verify live session with no generated title uses the prompt, manual rename wins, and a mid-session model switch fires `session:update`.
- [x] 5.3 `subagents.ts`: link `spawn_subagent` and `subagents/<id>/meta.json` by `subagent_id`; type/title/background/parentId; completion from `meta.json` status / `output.json`; cancel foreground on parent idle; background outlives idle; never emit a `session_kind` `subagent` as a root, even if it is in the live index. Verify every Subagent lifecycle scenario, including meta-before-tool-use yielding one start, catch-up of a running background child, nested parentId, and subagent transcript not affecting root activity.

## 6. History, inspect, headless

- [x] 6.1 `list.ts`: walk `sessions/*/*/summary.json`, skip `session_kind` `subagent`/`subagent_fork`, bounded metadata, `since` short-circuit on mtime, `id` hint. Verify subagent exclusion, `title_is_manual` over `generated_title` over prompt, headless kind, and a large chat history not fully parsed when the summary already has a title.
- [x] 6.2 `inspect`: `transcript()` / `events()` replay and tail mapped `chat_history.jsonl` for sessions and subagents; honor `AbortSignal`. Verify appending a user record yields a new `user` event, `break`/`close()` releases the watch, and a closed session's subagents all have final statuses.
- [x] 6.3 Headless: no live events without an index entry; `session_kind` `headless` listed with `kind` `headless`. Verify a print-mode fixture via `sessions({ since, kind: 'headless' })`.

## 7. Conformance and fixtures

- [x] 7.1 Write `src/testing/grok-driver.ts` implementing `FixtureDriver` against Grok files (`active_sessions.json`, session dirs, `events.jsonl` phases, `chat_history.jsonl`, `summary.json`, `subagents/<id>/meta.json`). Export it from `src/testing/index.ts`. Verify it compiles.
- [x] 7.2 Run `defineConformanceTests` against `grokBuild({ home })` with that driver. Verify every conformance case passes.
- [x] 7.3 Capture scrubbed real Grok Build fixtures under `test/fixtures/grok-build/` (index snippet, multi-turn events + chat history, foreground and background meta/output, permission prompt, failed turn, cancelled subagent, `title_is_manual`, headless summary). Verify grep finds no home path or original prompt text.
- [x] 7.4 Add expected-output snapshots for mapping, activity, subagents, and listing of those fixtures, plus a compat test pinning the allowed index fields. Verify the tests pass.

## 8. Packaging, docs, live tests

- [x] 8.1 Add `grokBuild` to `builtInProviders` and re-export it from `src/index.ts`. Update pack test, `test/types/readme.ts`, and `test/types/usage.ts`. Verify `npm pack` install still imports both entry points and `--json` is `[]` when `GROK_HOME` and `CLAUDE_CONFIG_DIR` point at empty temps.
- [x] 8.2 README: Grok Build section parallel to Claude Code (home, live index, encoding, status from `events.jsonl`, files never opened). Keywords include `grok`. Verify README snippets still typecheck.
- [x] 8.3 E2e helpers: isolated `GROK_HOME` with an OpenRouter `[model.e2e]` (`x-ai/grok-4.6`, `OPENROUTER_API_KEY`), `GROK_TRACK_HEADLESS=1`, `grok -p --yolo --effort low -m e2e`. Verify helpers compile and live tests skip without `AYA_LIVE=1`.
- [x] 8.4 Opt-in live smoke (`AYA_LIVE=1`): start `grok -p`, wait for create/open → status → close, and `sessions({ since: startOfToday })`. Verify it passes locally and is skipped by default.
- [x] 8.5 Opt-in live subagents: prompt that spawns three `general-purpose` subagents, wait for three `subagent:start` and three `subagent:end`. Verify it passes locally and is skipped by default.
- [x] 8.6 `npm test`, `npm run lint`, and `npm run test:coverage` pass. Verify no `setInterval` was added outside `helpers/coalesce.ts`.
