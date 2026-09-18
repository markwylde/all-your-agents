## Context

See proposal.md for why. Claude Code is already a complete built-in: `src/providers/claude-code/**`, a fixture driver, conformance, captured 2.1 fixtures, and `AYA_LIVE=1` e2e against OpenRouter. The core, helpers, and ADR 0001 stay unchanged.

Grok Build (source at `/Users/mark/Documents/Projects/grok-build`) writes:

- Live index: `<home>/active_sessions.json`, an atomically rewritten array of `{ session_id, pid, cwd, opened_at }`. TUI always registers; `grok -p` only if `GROK_TRACK_HEADLESS` is set. `active_sessions.lock` / `.tmp` sit beside it.
- Session dir: `<home>/sessions/<url-encoded-cwd>/<uuid>/` with `summary.json`, `events.jsonl`, `chat_history.jsonl`, `subagents/<id>/meta.json` + `output.json`. Encoded names longer than 255 bytes become `{slug}-{blake3_hex16}` plus a `.cwd` file.
- `events.jsonl` is the phase/turn/tool log (`turn_started`, `phase_changed`, `tool_started`, `permission_*`, `turn_ended`). It is chatty (hundreds of `phase_changed` per turn).
- `chat_history.jsonl` is the model conversation (`user` / `assistant` / `tool_result` / `reasoning`).
- `updates.jsonl` is the ACP chunk stream used by `/resume`. Not a status source.
- `summary.json` holds `generated_title`, `title_is_manual`, `current_model_id`, `session_kind` (`headless` | `subagent` | absent), timestamps.

Home is `$GROK_HOME` or `~/.grok`.

## Goals / Non-Goals

**Goals:**
- A second provider module that is a peer of Claude Code: same contract, same helpers, same conformance kit, same test layers.
- Status from `events.jsonl` (Grok's status log), conversation from `chat_history.jsonl`, identity from `active_sessions.json`.
- `watchFile` follows the path so Grok's tmp-then-rename files keep delivering on Linux.
- Offline tests against a fake home; live tests against a real `grok` via OpenRouter, skipped in CI.

**Non-Goals:**
- Changing the core, helpers, CLI, or Claude provider except wiring `builtInProviders` and docs.
- Adding blake3 or any other runtime dependency. Long-cwd hash names are found by the bounded lookup and `.cwd`, not recomputed.
- Tailing `updates.jsonl`, `signals.json`, `terminal/*.log`, or `session_search.sqlite`.
- Launching agents, ACP sockets, or treating running subagent processes as extra root sessions.
- Windows.

## Decisions

**Layout.** Same shape as Claude Code. `index.ts` is still the only file that imports a provider. Neutrality test also forbids `.grok` / `GROK_HOME` in `src/core/**`.

```
src/providers/grok-build/   paths.ts, index-file.ts, status.ts, events.ts,
                            journal.ts, list.ts, activity.ts, subagents.ts, provider.ts
src/testing/grok-driver.ts
test/providers/grok-build/
test/fixtures/grok-build/<version>/
```

**One-file live index, keyed by session_id.** Claude watches `<home>/sessions/<pid>.json` (one file per pid). Grok rewrites one array and `register` dedupes by `session_id` only, so one pid can hold several entries (dashboard agents). Bound map is `session_id → bound`. Diff: added id → bind, removed id → close, same id new `cwd` → relocate. A conversation switch is one removal plus one addition, never "this pid's session_id changed". `watchProcess` is refcounted per pid: one watch, exit closes every bound session for that pid.

`watchFile` on `active_sessions.json` (parent dir + filename filter). If `<home>` does not exist, `watchDir` on that path until the file exists, then `watchFile`. Watching the parent of the index *is* watching home, but the filename filter ignores `config.toml` / `auth.json`.

**Status source is `events.jsonl`, not the index.** The index has no status field. This is not "inferring from chat history": `events.jsonl` is Grok's dedicated phase log, the analog of Claude's session-file `status`. Reduce phases with a pure function. `permission_prompt` plus the latest `permission_requested.tool_name` → `waiting`. `turn_ended` or no open turn → `idle`. MCP-only logs stay idle. Chat history never sets `status`.

**Two tails per live session.** `events.jsonl` → status + turn facts. `chat_history.jsonl` → titles, `user`/`assistant`/`tool` mapping, `spawn_subagent`. `summary.json` via `watchFile` → harness/user title and `current_model_id` at bind. Do not tail `updates.jsonl` (chunked ACP, duplicates the conversation).

**No blake3.** Derived path percent-encodes every byte except RFC 3986 unreserved (`A-Za-z0-9-._~`), matching Rust `urlencoding::encode` — not `encodeURIComponent`, which leaves `!'()*`. When the encoding exceeds 255 bytes, skip derive and do the one-level lookup for `<session_id>/`, reading `.cwd` only to recover `cwd` for listing. Fixtures for the long-cwd case create the slug-hash directory themselves.

**watchFile watches the parent directory.** Today's helper does `fs.watch(path)` first and only falls back to the parent if that throws. Grok writes `active_sessions.json`, `summary.json`, and `meta.json` by tmp-then-rename. On Linux, inotify follows the inode, so the first rewrite leaves the watch on a deleted file and later rewrites are silent. macOS FSEvents follows the path, so this was invisible here. Fix the helper: always `fs.watch(parent)` filtered by filename, ancestor-walk when the parent is missing (same as `watchDir`). Add a test that does two tmp-then-rename cycles. Claude never hit this because it uses `watchDir` on `sessions/`. `tailJsonl` can stay on the file inode: Grok's jsonl files are append-only.

**Subagents match Claude's shape, Grok's files.** `subagents/<id>/meta.json` is the analog of Claude's `agent-*.meta.json`. Watch that directory. Link by `subagent_id`. Child `chat_history.jsonl` is the subagent transcript. `session_kind` `subagent` / `subagent_fork` are never roots, including if they appear in the live index. Background vs foreground from spawn `background` or the "started in background" tool result. Core still cancels open subagents on parent close.

**Validation.** Index: parse array, size bound, UUID `session_id`, live pid, `opened_at >= processStart - 5s`. `opened_at` is `Utc::now()` at register (every load/resume/new), not process start — a `/resume` a minute after launch must pass. No upper bound. Recycled pid still fails: the old `opened_at` is hours before the new process start. Unknown start + alive → accept. Corrupt file → no events, keep watching (a torn write is ignored until the next valid rewrite, so we do not close everyone).

**Subagent kind at bind.** The index has no `session_kind`. One bounded `summary.json` read at bind; `subagent` / `subagent_fork` are not roots. Grok is not observed to put subagents in the index; the read is fail-closed.

**Create vs open.** Session directory exists at bind → `open`, else `create`.

**Relocation.** Same id, new cwd → re-resolve, swap tails, silent replay. Unfinished move keeps the old tails.

**Headless.** No index entry → history only, `kind` from `session_kind`. Live tests set `GROK_TRACK_HEADLESS=1` so `grok -p` registers, giving create → status → close without driving the TUI.

**Live tests use OpenRouter, not xAI.** Isolated `GROK_HOME` with a `[model.e2e]` pointing at `https://openrouter.ai/api/v1`, `model = "x-ai/grok-4.6"`, `env_key = "OPENROUTER_API_KEY"`. Invoke `grok -p --yolo --effort low -m e2e`. Same `AYA_LIVE=1` + `OPENROUTER_API_KEY` gate as Claude. Cost wrapper reused.

**Conformance driver.** Writes `active_sessions.json`, session dirs, `events.jsonl` phases, `chat_history.jsonl` records, `summary.json`, and `subagents/<id>/meta.json`. `rewriteStatus` appends the matching `phase_changed` / `turn_ended`. `switchConversation` removes the old id and adds the new id with the same pid (close then open). `relocateJournal` changes cwd in the index and moves the session dir. `failTurn` appends `turn_ended` `error` without a message; optional chat-history error text is a Grok-specific test, not a kit requirement.

**Failed turns.** `turn_ended` has `outcome` but no message. `lastTurn` is `failed`; `activity.error` comes from a matching chat-history error record when present, else omitted.

**Fixture capture.** One real Grok Build session (this machine's current format): index snippet, multi-turn `events.jsonl` + `chat_history.jsonl`, foreground and background `meta.json`/`output.json`, a `permission_prompt` turn, a `turn_ended` `error`, a cancelled subagent, a `title_is_manual` summary, a `session_kind=headless` summary. Scrub prompts, home paths, git remotes. Pin expected mapping.

**Alternatives rejected.**
- Status from `signals.json` or summary mtime — counters, not phases; would poll-equivalent guess idle.
- Tailing `updates.jsonl` for transcripts — chunked, harder to map, and `/resume`'s concern, not ours.
- Listing via `session_search.sqlite` — extra format, not event-driven, not needed for a bounded directory walk of `summary.json`.
- Showing live subagent pids as extra `running()` rows — violates "subagents are not sessions".
- `opened_at` within ±5 s of process start — copied from Claude `startedAt`; Grok stamps `Utc::now()` on every register, so `/resume` and slow startup would all reject.
- Keying the bound map by pid — `register` dedupes by `session_id` only; the dashboard holds several agents in one process.

## Risks / Trade-offs

- [Grok changes `events.jsonl` phase words] → Unknown phases omit `status`. Compat test pins the observed set. Refresh fixtures per Grok release.
- [Torn `active_sessions.json` mid-rename] → Atomic rename is the write path; a corrupt read is ignored, so a torn file does not close everyone. Next valid rewrite converges.
- [Hundreds of `phase_changed` per turn] → Coalesce to 1 s ceiling. Reducer is cheap and idempotent; consumers see settled status.
- [`tool_started` has no `tool_call_id`] → `activity.tool.id` is `tool_name` until `tool_completed`. Parallel same-name tools can collapse; accepted, Grok often serializes tools through permission.
- [Headless does not unregister the index] → Process-exit watch (or `reconcile`) closes it. Same as Claude `kill -9`.
- [Long cwd without `.cwd`] → Bounded lookup still finds `<id>/`; `cwd` may be missing on the snapshot until the index supplies it.
- [`fs.watch` on a file replaced by rename] → Helper now watches the parent directory. A two-cycle tmp-then-rename test pins Linux. Churn catch-up still covers the macOS FSEvents rebuild gap.
- [OpenRouter model id or effort flag drifts] → e2e helpers keep model/effort in one place (`AYA_E2E_GROK_MODEL`, default `x-ai/grok-4.6`, effort `low`).
- [A background subagent outlives the parent TUI] → Core cancels it on `session:close`. The child dir remains for history. We do not promote it to a root.

## Migration Plan

Additive. Existing Claude consumers keep working. Default `AllYourAgents()` starts watching `~/.grok` as well as `~/.claude`; hosts that must not can pass `providers: [claudeCode()]`. No data migration. Rollback is revert.

## Open Questions

None that block implementation. Whether to expose Grok `reasoning_effort` on `Session` later is additive and out of this change.
