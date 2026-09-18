## Why

Claude Code and Grok Build are the only built-in providers. Codex CLI is the other coding-agent CLI in daily use here: it already writes per-thread rollout JSONL under `$CODEX_HOME/sessions`, first-class subagent rollouts, and turn lifecycle events. Until aya observes those files the same way it observes Claude and Grok, `all-your-agents` and the TUI miss every Codex session.

## What Changes

- Add a Codex CLI provider as a third built-in, exported as `codexCli(options)` and included in `builtInProviders`. Provider id `codex-cli`, harness `Codex`. Home is `$CODEX_HOME` if set, otherwise `~/.codex`, overridable via `codexCli({ home })`.
- Discover live sessions from rollout files a live Codex process currently has open (`sessions/YYYY/MM/DD/rollout-*.jsonl`). Codex writes no pid index; pid comes from a one-time holders probe on those files, then `watchProcess`. Headless `codex exec` is live while that process holds the file, then history with `kind` `headless`.
- Map Codex's on-disk layout into the existing session API: status from the turn-lifecycle `event_msg` records Codex persists (`task_started` / `task_complete` / `turn_aborted`), turn failure from `task_complete.error`, tool activity and conversation from `response_item`, identity and cwd from `session_meta`, subagents from child rollouts with `parent_thread_id` / `thread_source` `subagent`.
- Codex does not persist approval requests, `error`, `*_begin`, or `collab_*` events (`rollout/src/policy.rs`), so Codex sessions never report `waiting`: a session blocked on an approval reads as `running`. This is a documented harness limit, not a timer-based guess.
- Follow ADR 0001: watch the date tree as directories appear, tail bound rollouts, never poll, never treat mtime or "recently written" as liveness, never open lock/auth/sqlite/ipc files.
- Extend `Processes` with an optional one-time `heldUnder(directory)` / `holders(path)` probe so Codex can bind without a written index. Claude and Grok ignore it.
- Run the existing conformance kit against a Codex fixture driver. Capture scrubbed real fixtures. Add opt-in live smoke tests (`AYA_LIVE=1`) that start `codex exec` against OpenRouter over `wire_api = "responses"` (Codex removed `chat`).
- Document the provider in the README. The TUI and public API stay harness-neutral; Codex sessions appear as another harness.

## Capabilities

### New Capabilities
- `codex-cli-provider`: How Codex CLI (and VS Code Codex, which shares the same home and rollout format) sessions are discovered, validated, mapped to status, listed from history, and inspected, plus how turn activity and subagent lifecycles are derived from Codex's own files.

### Modified Capabilities
- `harness-providers`: The conformance kit SHALL also pass against the Codex CLI provider with its fixture driver. `Processes` MAY implement a one-time `heldUnder` / `holders` probe so a provider whose harness writes no pid index can still bind live sessions without polling.

## Impact

- New code: `src/providers/codex-cli/**`, `src/testing/codex-driver.ts`, `test/providers/codex-cli/**`, `test/fixtures/codex-cli/`, live/e2e helpers for `codex`.
- Helper change: `src/helpers/types.ts` and `src/helpers/processes.ts` add optional `heldUnder` / `holders` (local implementation via `lsof` / `/proc/*/fd`). No new runtime dependencies.
- `src/index.ts` adds `codexCli` to `builtInProviders` and re-exports it. Pack test and README type snippets import it.
- Neutrality test: core still must not mention `.codex` / `CODEX_HOME`; providers still must not import `node:fs`.
- README: Codex CLI section parallel to Claude Code and Grok Build; keywords include `codex`.
- Layout is pinned to the local Codex checkout at `/Users/mark/Documents/Projects/codex` (`main` @ `7498521`). Runtime reads only `<home>/sessions/YYYY/MM/DD/rollout-*.jsonl` (live tails) and `<home>/session_index.jsonl` (titles). History MAY notice `*.jsonl.zst` by filename without decompressing. It never opens `auth.json`, `state_*.sqlite`, `ipc/ipc.sock`, `process_manager/chat_processes.json`, or `history.jsonl`.
- Live tests need `OPENROUTER_API_KEY` and a `codex` binary, skipped by default like Claude and Grok.
- Windows remains out of scope.
