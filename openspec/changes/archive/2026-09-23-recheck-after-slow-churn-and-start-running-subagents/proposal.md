## Why

Two ways a consumer could miss an event, both found while making the Linux and macOS system tests reliable:

- On macOS a watch open or close rebuilds the process's single FSEvents stream, and a write during the rebuild is lost. The churn catch-up looked once, a debounce after the churn; on a loaded machine the rebuild outlasts that, so a write landing just after the pass was never seen.
- A subagent still running when its session binds was reported through `subagents()` but never announced with `subagent:start` by codex-cli (when the child rollout was read before the parent bound) and oh-my-pi (whenever the child was already there). `agent-sessions` requires a start for every running subagent at catch-up, and grok-build and claude-code already do it.

## What Changes

- Shared watch helpers make a second churn pass at the latency ceiling after the first churn of a burst. Still churn-triggered, still only reporting real differences, and no timer remains after it.
- **codex-cli**: a running child found before its parent binds emits `subagent:start` when the parent binds.
- **oh-my-pi**: a running child present at bind emits `subagent:start`; ended children are still reported only through `subagents()`. That capability's spec is still in the unarchived `add-omp-provider` change, so it is corrected there directly.
- No spec change for the Linux process watcher fixes in the same PR (the variadic `pidfd_open` syscall and its arm64 number): they bring the code in line with the existing `pidfd` requirement.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `harness-providers`: churn catch-up makes up to two passes.
- `codex-cli-provider`: running subagents at bind are started.

## Impact

- Code: `src/helpers/{watch-dir,watch-file,tail-jsonl}.ts`, `src/providers/codex-cli/provider.ts`, `src/providers/oh-my-pi/provider.ts`.
- Docs: `docs/adr/0001-never-poll.md`.
- Consumers see `subagent:start` (with `catchUp: true` during `start()`) for subagents they previously saw only through `subagents()`.
