## Context

See proposal.md for why. Claude Code and Grok Build are already complete built-ins: provider modules, fixture drivers, conformance, captured fixtures, and `AYA_LIVE=1` e2e against OpenRouter. The core, helpers, and ADR 0001 stay unchanged except an optional one-time holders probe on `Processes`.

Layout is pinned to `/Users/mark/Documents/Projects/codex` `main` @ `7498521` (`codex-rs/rollout`, `codex-rs/protocol`). Codex writes:

- Rollouts: `<home>/sessions/YYYY/MM/DD/rollout-<UTC-timestamp>-<thread-id>.jsonl`, append-only (`OpenOptions::append`). Resume materializes a `.jsonl.zst` back to plain `.jsonl` then appends. `thread/revert` writes a new file `rollout-<ts>-<thread-id>_<rollout-id>.jsonl` (parser in `rollout_file_name.rs`: thread id is the UUID after the timestamp, not the one after `_`).
- First line is `session_meta`: `session_id` (root thread), `id` (this thread), `cwd`, `source` (`cli` | `vscode` | `exec` | `mcp` | `{ subagent: { thread_spawn } }`), `thread_source` (`user` | `subagent` | …), optional `parent_thread_id`, `originator` (`codex-tui` / `codex_cli_rs`), `cli_version`, `git`. **No pid.** Confirmed in `protocol.rs` `SessionMeta`.
- Later lines: `event_msg`, `response_item` (conversation + tool calls), `turn_context`, `token_usage_record`, `world_state`, `compacted`.
- **Only a few `event_msg` types reach disk.** `rollout/src/policy.rs` `should_persist_event_msg` persists `task_started` (alias `turn_started`), `task_complete` (alias `turn_complete`), `turn_aborted`, `thread_settings_applied`, `token_count`, `thread_goal_updated`, `thread_rolled_back`, and `item_completed`. Everything else is "transient, non-durable": all approval/input requests, `error`, every `*_begin`, `exec_command_end`, all `collab_*`, `mcp_startup_*`, `shutdown_complete`. A histogram of this machine's September rollouts confirms it: `item_completed`, `token_count`, `task_started`, `task_complete`, `thread_settings_applied`, `turn_aborted`, nothing else.
- `item_completed` content depends on `ThreadHistoryMode`. The TUI starts non-ephemeral threads `paginated` (`tui/src/app_server_session.rs`), which persists every `TurnItem` (`Reasoning`, `CommandExecution`, `AgentMessage`, `FileChange`, `SubAgentActivity`, `CollabAgentToolCall`, `UserMessage`, `McpToolCall`, …). `legacy` (the enum default) persists only `FunctionCallOutput`, `Plan`, sleep, and completed `SubAgentActivity`. `response_item` records are persisted in both modes, so they are the floor.
- A failed turn is `task_complete` with `error: { message, codex_error_info }` (`TurnCompleteEvent.error`, set in `core/src/tasks/mod.rs`). `turn_aborted` has `reason` `interrupted` | `replaced` | `review_ended` | `budget_limited`.
- Subagents: sibling rollouts with `parent_thread_id` / `thread_source` `subagent`, and `agent_nickname` / `agent_role` / `agent_path` on the child `session_meta` (539 of them on this machine, all `originator` `codex-tui`, so they share the parent's pid). In `paginated` mode the parent also has `item_completed` `CollabAgentToolCall` items: `tool` `spawn_agent` with `receiver_agents: [{ thread_id, agent_nickname }]` and `agents_states: { <id>: "pending_init" }`; `wait` / `close_agent` with `agents_states: { <id>: { completed: "<last message>" } }` (`AgentStatus`: `pending_init`, `running`, `interrupted`, `completed`, `errored`, `shutdown`, `not_found`).
- The recorder defers creating a new rollout until first materialization (`deferred_creation`), then keeps one append handle open for the life of the thread (`RolloutWriterState.writer`); it is dropped only on I/O error (and reopened) or shutdown. Resume opens the existing file for append without writing.
- Titles: `<home>/session_index.jsonl` is append-only `{ id, thread_name, updated_at }`; newest entry wins (`session_index.rs`). Not a live index.
- `state_*.sqlite` has `threads` and `thread_spawn_edges` but no pid. `core/src/unified_exec/process_manager.rs` tracks exec-child osPids, not the TUI.

Home is `$CODEX_HOME` or `~/.codex`. Interactive sources in Codex itself: `cli`, `vscode`, custom `atlas` / `chatgpt`.

## Goals / Non-Goals

**Goals:**
- A third provider module that is a peer of Claude Code and Grok Build: same contract, same helpers, same conformance kit, same test layers.
- Live identity from "which process has this rollout open", status from `event_msg`, conversation from `response_item`.
- Offline tests against a fake home; live tests against a real `codex exec` via OpenRouter, skipped in CI.

**Non-Goals:**
- Changing the core, CLI, Claude, or Grok providers except wiring `builtInProviders`, the optional `Processes` probe, and docs.
- Opening sqlite, `auth.json`, `ipc.sock`, `chat_processes.json`, `history.jsonl`, attachments, or `*.jsonl.zst`.
- Adding a zstd or sqlite dependency.
- A separate VS Code harness (same files, same provider).
- Launching agents, talking to `ipc.sock`, or promoting subagent rollouts to `running()` rows.
- Windows.

## Decisions

**Layout.** Same shape as the other providers. `index.ts` is still the only file that imports a provider. Neutrality test also forbids `.codex` / `CODEX_HOME` in `src/core/**`.

```
src/providers/codex-cli/   paths.ts, session-meta.ts, status.ts, events.ts,
                           journal.ts, list.ts, activity.ts, subagents.ts, provider.ts
src/testing/codex-driver.ts
test/providers/codex-cli/
test/fixtures/codex-cli/<version>/
```

**Live set is open files, not a written index.** Claude watches `<home>/sessions/<pid>.json`. Grok watches `active_sessions.json`. Codex has neither. A rollout is live iff `holders(path)` returns a pid that passes validation. At `watch` start, one `heldUnder(sessions/)` call finds currently open rollouts (allowed: one-time probe in response to start). After that, a create/change in a watched day directory on an unbound `rollout-*.jsonl` triggers `holders(path)` once.

Bound map is `thread-id → bound`. Diff: newly held id → bind, no longer held → close, same id new cwd → `session:update`. A conversation switch is the pid dropping A and holding B (close then open), never "this pid's session_id changed". `watchProcess` is refcounted per pid.

**A close(2) is silent.** Dropping a handle raises no fs event, so "no longer held" is only ever learned from a probe. Rule: whenever we bind a rollout for pid P, or service a notification on a rollout bound to P, re-probe `holders` for P's other bound rollouts in the same pass. That makes the TUI's `/new` and `/resume` (B appears → A re-probed → close A, open B) work with no timer. What it cannot see: a long-lived process (VS Code, app-server) unloading a thread while touching nothing else. That session stays listed until the next notification for that pid, `reconcile(pid)`, or exit. Accepted; the alternative is polling.

**Two visibility gaps, both accepted.** A launched Codex with no prompt yet has no rollout (deferred creation), so it is not a session until the first prompt. A `/resume` after `watch` started raises no event until the first append, so it appears on the first prompt, not at resume. A resume before `watch` started is caught by the start `heldUnder` probe.

When `heldUnder`/`holders` is missing, no live Codex rows; `list` still works. Fake `Processes` in tests implement `heldUnder`/`holders` from a map the fixture driver updates.

**Local holders implementation.** macOS: `lsof -F pn` on the directory, parse pid/name, keep paths under the prefix that end in `.jsonl`. Linux: read `/proc/*/fd` links. Both are one-shot child processes / reads, never on a timer. Do not use `lsof +D` recursive-on-a-timer. Filter to the Codex binary name when cheap, but do not require it (tests and remote brokers may use a stub pid).

**Date-tree watches, not 3000 file watches.** `watchDir` on `sessions/`, then on each year, month, and day directory the initial scan (and later creates) report. That is how `watchDir` already expands a missing path; here the tree exists. ~135 day dirs on this machine, one watch each, not one per jsonl. New days appear as creates on the month dir. `tailJsonl` only on bound roots and running children.

Rejected: watching only "today" from the clock — `/resume` appends to an old date's file, and aya would miss it. Rejected: recursive `fs.watch` — Linux cannot, and the helper is one-level by spec.

**Status source is `event_msg`, not `response_item`.** Reduce with a pure function:

- `task_started` / `turn_started` → `running`
- `task_complete` / `turn_complete` / `turn_aborted` → `idle`

That is the whole persisted lifecycle. Unknown types leave status unchanged. This is the analog of Claude's session-file `status` and Grok's `events.jsonl`, but narrower.

**No `waiting` for Codex.** Approval and input requests are transient events and never reach the rollout, and nothing else on disk marks them (sqlite and `ipc.sock` are off limits). A session blocked on an approval reads as `running` with its tool call open. We do not guess `waiting` from "a tool call has had no output for N seconds": that is a timer and would misreport long builds. Documented in the README as a harness limit.

**Tool activity from `response_item`, failure from `task_complete.error`.** `*_begin` / `exec_command_end` / `error` are not persisted. Tool start is the `function_call` / `custom_tool_call` / `local_shell_call` record, tool finish is the `*_output` with the same `call_id`. `item_completed` `CommandExecution` etc. are not used for tools: their ids are `exec-<uuid>`, not the `call_id`, and one `exec` call can run several commands. A failed turn is `task_complete` with `error` set.

**One tail per live session.** The rollout mixes lifecycle and conversation. One `tailJsonl` feeds the status reducer (`event_msg` turn lifecycle), the activity reducer (lifecycle + `response_item` tool calls), and the journal mapper (`response_item`). Do not tail sqlite or `session_index.jsonl` for liveness. `session_index.jsonl` may be tailed only for `harness` titles (`thread_name`).

**Validation.** First-line `session_meta`, size bound, UUID `id`, live holder pid, `timestamp >= processStart - 5s`, no upper bound. Recycled pid still fails: old meta timestamp is hours before the new process start. Unknown start + alive → accept. Corrupt first line → no event, keep watching.

**Create vs open.** A rollout for that thread id already on disk (history would list it) → `open`, else `create`.

**Subagents match Claude's shape, Codex's files.** Child rollout `parent_thread_id` is the analog of Grok's `subagents/<id>/`. Watch the date dir; link by child thread id. The child's `session_meta` (`parent_thread_id`, `agent_nickname`, `agent_role`) is the source of truth and works in every history mode. The parent's `item_completed` `CollabAgentToolCall` `spawn_agent` (`receiver_agents[].thread_id`) is an optional earlier hint in `paginated` mode; the `collab_agent_spawn_*` events are never persisted. Transcript is the child jsonl. `session_meta.source.subagent` / `thread_source` `subagent` are never roots, including if held. Codex spawns every agent asynchronously and has no foreground flag, so `background` starts false and flips true if the parent's turn ends while the child's is open; nothing is cancelled on parent idle. Completion comes from the child's own `task_complete` (with `error` → failed) / `turn_aborted` (→ cancelled), or from a parent `wait` / `close_agent` `agents_states` entry (`completed` → completed, `errored` → failed, `interrupted` / `shutdown` / `not_found` → cancelled), first one wins. A child that gets more input after ending is not restarted. Core still cancels open subagents on parent close.

**Revert is relocate, not a new session.** Same thread id, new path with `_<rollout-id>`. Swap the tail; do not `session:create` for the rollout id. History lists one row per thread id.

**Compressed history without zstd.** Idle rollouts may exist only as `.jsonl.zst`. List them by filename + `session_index.jsonl` and do not decompress. Live resume always materializes a plain `.jsonl` first (`materialize_rollout_for_append_blocking`), so tails stay on jsonl. Prefer the plain sibling when both exist.

**Headless.** `source` `exec` (`codex exec`) is live while held, then `kind` `headless` in history. Live tests use `codex exec` so we get create → status → close without driving the TUI.

**Live tests use OpenRouter.** Isolated `CODEX_HOME` with:

```toml
[model_providers.openrouter]
name = "OpenRouter"
base_url = "https://openrouter.ai/api/v1"
env_key = "OPENROUTER_API_KEY"
wire_api = "responses"
```

with top-level `model = "x-ai/grok-4.6"`, `model_provider = "openrouter"`, `approval_policy = "never"`, `sandbox_mode = "danger-full-access"` placed **before** the `[model_providers.openrouter]` table (TOML: keys after a table header belong to that table).

`wire_api = "chat"` no longer loads: `model-provider-info/src/lib.rs` rejects it with `CHAT_WIRE_API_REMOVED_ERROR`, and `responses` is the only variant. So the e2e depends on OpenRouter's Responses endpoint (`/api/v1/responses`) and on the chosen model working through it with tool calls. Task 8.3 verifies that with one real `codex exec` before the smoke tests are written; if it does not work, fall back to any Responses-compatible endpoint behind the same `AYA_E2E_CODEX_*` env names.

Invoke `codex exec -s danger-full-access --dangerously-bypass-approvals-and-sandbox -m "$AYA_E2E_CODEX_MODEL" -C "$cwd" "$prompt"`. Default model `x-ai/grok-4.6` (same OpenRouter key as Grok e2e; override with `AYA_E2E_CODEX_MODEL`). Same `AYA_LIVE=1` + `OPENROUTER_API_KEY` gate. Cost wrapper reused.

**Conformance driver.** Writes `sessions/YYYY/MM/DD/rollout-*.jsonl` and updates an in-memory holders map the fake `Processes` reads. `createLiveSession` creates the file, puts `{path, pid}` in the map, which makes `heldUnder` return it. The driver writes only records real Codex persists. `rewriteStatus('busy')` appends `task_started`, `rewriteStatus('idle')` appends `task_complete`; any other status string (the kit never sends `waiting`) is a no-op. `switchConversation` removes the old id from the holders map, then creates the new rollout with the same pid; the create notification is what makes the provider re-probe the old one. `remove` drops the holder and deletes the file so a notification fires. `relocateJournal` moves the file and updates the holders path. `runTurnWithTool` appends `task_started`, a `function_call`, its `function_call_output`, `task_complete`. `failTurn` appends `task_complete` with `error: { message }`, no standalone `error` event. Subagent helpers write a child rollout with `parent_thread_id` / `agent_nickname` and its own `task_started`; finish appends the child's `task_complete`. `launchBackgroundSubagent` is the same child, left open across the parent's `task_complete`. No `collab_*` events are written; one driver variant also writes the `item_completed` `CollabAgentToolCall` hint so both link orders are covered.

**Fixture capture.** One real Codex CLI session (this machine's current format): a root rollout with multi-turn `event_msg` + `response_item` (including `item_completed` items), an aborted turn (`turn_aborted`), a failed turn (`task_complete.error`) if one can be provoked, otherwise hand-built from the struct and marked synthetic, three collab child rollouts (nicknames) with the parent's `spawn_agent` / `wait` items, a `session_index.jsonl` title line, a `source: exec` headless snippet. No approval fixture: approvals are not persisted. Scrub prompts, home paths, git remotes, encrypted_content. Pin expected mapping.

**Files never opened.** `auth.json`, `state_*.sqlite` / `sqlite/`, `logs_*.sqlite`, `ipc/`, `process_manager/`, `history.jsonl`, `attachments/`, `*.jsonl.zst`.

**Alternatives rejected.**
- Status from last `response_item` — conversation can lag `task_complete`; would disagree with the TUI.
- Status, approvals, and subagents from `exec_approval_request` / `*_begin` / `error` / `collab_agent_spawn_end` — an earlier draft of this design; none of them are persisted (`policy.rs`).
- `waiting` from "open tool call, no output for N seconds" — a timer, and wrong for long commands.
- Listening on `ipc/ipc.sock` or the app-server for live approvals — not a file Codex writes for observers; out of scope and off limits.
- Liveness from mtime / "appended in the last N seconds" — a timer while idle, forbidden by ADR 0001; an idle TUI would look dead.
- Listing via `state_*.sqlite` — extra format, not needed for a bounded walk of date dirs + first-line `session_meta`.
- Using `chat_processes.json` as the live index — those are shell children, not Codex; idle TUI has none.
- Showing live subagent rollouts as extra `running()` rows — violates "subagents are not sessions".
- Watching only today's directory — misses `/resume` into an older date path.

## Risks / Trade-offs

- [Codex changes `event_msg` type names or its persistence policy] → Unknown types leave status unchanged. Compat test pins the observed set. Refresh fixtures per Codex release. If Codex ever persists approvals, `waiting` becomes an additive change.
- [No `waiting` status] → A Codex session stuck on an approval shows `running`. Documented; the TUI needs no change.
- [History mode varies] → `legacy` rollouts lack most `item_completed` items. Everything required works from `response_item` + child `session_meta`; `CollabAgentToolCall` is only a hint.
- [Quiet thread unload in VS Code / app-server] → Stale live row until the next event for that pid or its exit. No timer.
- [OpenRouter Responses endpoint or model incompatibility] → Verified first in task 8.3; endpoint and model are env-overridable.
- [Hundreds of `item_completed` / token records per turn] → Coalesce to 1 s ceiling. Reducer is cheap and idempotent.
- [135 day-directory watches on a busy home] → Directories, not files. `onWatchChurn` already covers macOS FSEvents rebuilds. Acceptable vs missing resumes.
- [`lsof` / `/proc` cost at start] → One `heldUnder(sessions/)` call, not per file. Day-dir creates call `holders` on the new path only.
- [Remote `fs` without matching `Processes.holders`] → Live Codex rows absent; history still works. Document it.
- [Encrypted reasoning / images in rollouts] → Unmapped. Fixtures scrub `encrypted_content`.
- [`thread/revert` suffix mistaken for the session id] → Parse with Codex's `RolloutFileName` rules; bind by thread id; treat the new file as relocate.
- [History empty after compression] → List `.jsonl.zst` by name; never open them.
- [OpenRouter model id drifts] → e2e helpers keep it in one place (`AYA_E2E_CODEX_MODEL`).
- [A background collab child outlives the parent TUI] → Core cancels it on `session:close`. The child file remains for history. We do not promote it to a root.

## Migration Plan

Additive. Existing Claude and Grok consumers keep working. Default `AllYourAgents()` starts watching `~/.codex` as well; hosts that must not can pass `providers: [claudeCode(), grokBuild()]`. No data migration. Rollback is revert.

## Open Questions

None that block implementation. Whether to expose Codex `reasoning_effort` on `Session` later is additive and out of this change.
