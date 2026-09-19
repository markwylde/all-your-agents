## Why

Claude Code, Grok Build and Codex CLI are the built-in providers. oh-my-pi (`omp`) is another coding-agent CLI in daily use here, and it leaves enough on disk to observe without guessing: a per-process presence file, a per-terminal breadcrumb naming the current session, a JSONL transcript per session with explicit stop reasons, and child transcripts for subagents. Until aya reads those, `all-your-agents` and the TUI miss every omp session. (OpenCode was looked at first and parked until its v2 ships; see `docs/research/opencode/research.md`.)

## What Changes

- Add an oh-my-pi provider as a fourth built-in, exported as `ohMyPi(options)` and included in `builtInProviders`. Provider id `oh-my-pi`, harness `OhMyPi`. Home is `~/.omp` (root name from `PI_CONFIG_DIR`), overridable via `ohMyPi({ home })`. Named profiles under `<home>/profiles/*` are observed too.
- Discover live sessions from omp's own registry (ADR 0002): the presence file `run/daemons/<hash>/clients/<pid>-<uuid>.json` says a process is alive, and the breadcrumb `agent/terminal-sessions/<tty>` says which session file that terminal is on. The two are joined by the process's controlling terminal, read with a new optional one-time `Processes.tty(pid)` probe. A session switch inside one process (`/new`, `/resume`) rewrites the breadcrumb and is reported as close then open.
- Map omp's transcript into the session API: status and turn outcome from assistant `stopReason` (`stop`, `length`, `toolUse`, `error`, `aborted`), tools from `toolCall` blocks, `tool_execution_start` markers and `toolResult` messages, titles from `title_change`, model from `model_change`, subagents from child transcripts in the session's artifact directory.
- omp writes no transcript until the first assistant message ends (checked live: 17 s after the prompt). The first turn is seen instead from `agent/history.db`, where omp inserts the prompt with its `session_id` on submit. Reading it needs SQLite, so the contexts gain an optional injected `sqlite` reader (default: `node:sqlite` when the running Node has it). Without it the provider still works; a new session's first turn reads `idle` until its transcript appears.
- A pending `ask` tool call reports `waiting` with `waitingFor` `ask`. Permission approvals never reach disk, so a session blocked on one reads `running` (omp's default approval mode is `yolo`).
- Headless runs (`omp -p`, no terminal) write no breadcrumb, so they appear in history only, as `claude -p` does.
- `watchFile` gains an option to also report writes made through a handle the writer keeps open, which a directory watch misses on macOS. `history.db-wal` is such a file.
- Run the conformance kit against an omp fixture driver, capture scrubbed real fixtures, add opt-in live tests (`AYA_LIVE=1`, omp on OpenRouter Sonnet), and document the provider in the README matrix.

## Capabilities

### New Capabilities
- `oh-my-pi-provider`: How oh-my-pi sessions are discovered from presence files and terminal breadcrumbs, validated, mapped to status and activity, listed from history, and inspected, and how subagents are derived from child transcripts.

### Modified Capabilities
- `harness-providers`: The conformance kit SHALL also pass against the oh-my-pi provider. `Processes` MAY implement a one-time `tty(pid)` probe. The contexts MAY carry an injected read-only `sqlite` reader, the one sanctioned way for a provider to read a SQLite file. `watchFile` SHALL be able to report writes through a held-open handle.

## Impact

- New code: `src/providers/oh-my-pi/**`, `src/testing/omp-driver.ts`, `test/providers/oh-my-pi/**`, `test/fixtures/oh-my-pi/`, live/e2e helpers for `omp`.
- Helper changes: `src/helpers/types.ts`, `src/helpers/processes.ts` (`tty`), `src/helpers/watch-file.ts` (held-open option), a new `src/helpers/sqlite.ts`, and `sqlite` on `WatchContext` / `ListContext` / `InspectContext` / `InstanceOptions` in `src/provider.ts`. No new runtime dependency; `engines` stays `node >= 20`.
- `src/index.ts` adds `ohMyPi` to `builtInProviders` and re-exports it. `Harness` gains `OhMyPi`. Pack test and README type snippets import it.
- Neutrality test: core must not mention `.omp`, `PI_CONFIG_DIR` or `PI_CODING_AGENT_DIR`; providers must not import `node:fs` or `node:sqlite`.
- Layout is pinned to the local checkout `/Users/mark/Documents/Projects/oh-my-pi` @ `78b7531` (`@oh-my-pi/pi-coding-agent` 18.2.6). Runtime reads `run/daemons/*/clients/*.json`, `agent/terminal-sessions/*`, `agent/sessions/**.jsonl`, and the `history` table of `agent/history.db`. It never opens `agent.db` (auth), `models.db`, `logs/`, `blobs/` or the `.lock` sidecars.
- Live tests need an `omp` binary and `OPENROUTER_API_KEY`, skipped by default; CI installs omp with Bun.
- Upstream `pi` (`~/.pi`) and Windows are out of scope.
