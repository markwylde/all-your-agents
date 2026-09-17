## Why

Every coding-agent CLI writes session state somewhere under `$HOME` in its own format, and none of them offer an API for "what is running right now" or "what did that session do." Tools that want an accurate, live view of agents end up re-implementing brittle per-harness heuristics (newest file, matching cwd, polling) that drift out of date. `all-your-agents` (aya) gives one event-driven, harness-neutral API, with Claude Code as the first built-in provider.

## What Changes

- Scaffold the package: TypeScript, ESM, Node.js ≥ 20, zero required runtime dependencies (`koffi` optional), `node:test` for tests, build to `dist/`.
- Add the harness-neutral core: `AllYourAgents({ providers })` with `start()`/`stop()`, the `session:create | open | status | update | close` and `ready` events, catch-up semantics, and the `running()`, `sessions()`, and `get()` queries.
- Adopt ADR 0001, "We never poll" (`docs/adr/0001-never-poll.md`): all change detection is filesystem and process notifications, coalesced per path with a quiet window and a latency ceiling. `reconcile(pid?)` lets a host feed in its own process facts.
- Add the provider contract (`Provider`, `WatchContext`, `ListContext`, `InspectContext`) with an injected `fs` and `processes` so a host can observe a remote machine, and shared helpers (`coalesce`, `watchDir`, `watchFile`, `tailJsonl`, `processInfo`, `watchProcess`). The core never references a specific harness.
- Add title precedence (`user` > `harness` > `process` > `prompt`) and journal relocation handling, so a session that enters a worktree stays one session.
- Add normalized `Turn`/`SessionEvent` types for `transcript()` and `events()`, with the original harness record kept on `raw`.
- Add the Claude Code provider as a separate module, exported as `builtInProviders` and as the `all-your-agents/claude-code` subpath.
- Add a reusable provider conformance kit, so any future provider is checked against the same lifecycle contract.
- Add `session.activity` (tool in progress, last turn completed/failed/interrupted, standing error, open subagent count) with a `session:activity` event, so consumers can tell "done" from "idle" without re-deriving state.
- Add subagents as first-class objects: `subagent:start` / `subagent:end` events, `session.subagents()`, nesting via `parentId`, background vs foreground, and per-subagent transcripts.
- Expose `kind` (`interactive` | `headless`) so print-mode/SDK runs show up in history without pretending to be live.
- Add `since` and `kind` filters to `sessions()` (e.g. "everything that ran today").
- Correct the README where it disagrees with observed Claude Code behavior: project directories encode every non-alphanumeric character as `-`, not just slashes.

## Capabilities

### New Capabilities
- `agent-sessions`: The public, harness-neutral API. Covers the instance lifecycle, session events and catch-up, the `Session` shape, activity, subagents, queries, and transcript replay and tailing.
- `harness-providers`: The contract a harness provider implements, the event-driven rules it must follow, the shared watch helpers, and the conformance kit.
- `claude-code-provider`: How Claude Code sessions are discovered, validated, mapped to status, listed from history, and inspected, plus how turn activity and subagent lifecycles are derived from Claude Code's own files.

### Modified Capabilities
<!-- none: no existing specs -->

## Impact

- New code: `src/core/**`, `src/providers/claude-code/**`, `src/testing/**` (conformance kit), and `test/**` with captured fixtures.
- `package.json` is rewritten (ESM, `exports` map, scripts, dev dependencies: `typescript`, `@types/node`, `biome`).
- The public API is new, so nothing breaks. The README gains `since`, the `Turn`/`SessionEvent` types, and the encoding correction.
- New doc: `docs/adr/0001-never-poll.md`.
- Runtime reads only `<home>/sessions/*.json` and `<home>/projects/**` (including `subagents/agent-*.jsonl` and `.meta.json`), where `<home>` is `$CLAUDE_CONFIG_DIR` or `~/.claude`. It never opens `.key` files or the messaging socket, and it never reads anything on a timer.
- Process exit notification uses kernel process events (`kqueue` on macOS, `pidfd` on Linux) reached through `koffi`, an optional dependency with prebuilt Node-API binaries. Without it, `processes.watch` reports `unsupported` and exits are caught on the next event or `reconcile`.
- Supports macOS and Linux. Windows is out of scope.
