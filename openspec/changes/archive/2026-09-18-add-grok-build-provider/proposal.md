## Why

Claude Code is the only built-in provider. Grok Build is the other coding-agent CLI in daily use here: it already writes a live index, per-session journals, and first-class subagent metadata under `$GROK_HOME`, and its source is local, so we can pin the layout instead of guessing. Until aya observes those files the same way it observes Claude, `all-your-agents` and the TUI miss every Grok session.

## What Changes

- Add a Grok Build provider as a second built-in, exported as `grokBuild(options)` and included in `builtInProviders`. Provider id `grok-build`, harness `Grok`. Home is `$GROK_HOME` if set, otherwise `~/.grok`, overridable via `grokBuild({ home })`.
- Discover live sessions from `<home>/active_sessions.json` (the TUI crash-recovery index; one pid may hold several session ids). Headless `grok -p` is history-only unless `GROK_TRACK_HEADLESS` is set.
- Map Grok's on-disk layout into the existing session API: status and turn activity from `events.jsonl` phases, titles and model from `summary.json`, conversation from `chat_history.jsonl`, subagents from `<session>/subagents/<id>/meta.json` plus the child's own session dir.
- Follow ADR 0001: watch `active_sessions.json`, each bound session's files, and the process; never poll, never scan `sessions/` recursively, never open lock/tmp/auth files.
- Fix `watchFile` to watch the parent directory filtered by filename, so tmp-then-rename rewrites keep delivering on Linux inotify (Grok's index, `summary.json`, and `meta.json` all write that way).
- Run the existing conformance kit against a Grok fixture driver. Capture scrubbed real fixtures. Add opt-in live smoke tests (`AYA_LIVE=1`) that start `grok` against OpenRouter (`x-ai/grok-4.6`, `--effort low`).
- Document the provider in the README. The TUI and public API stay harness-neutral; Grok sessions appear as another harness.

## Capabilities

### New Capabilities
- `grok-build-provider`: How Grok Build sessions are discovered, validated, mapped to status, listed from history, and inspected, plus how turn activity and subagent lifecycles are derived from Grok's own files.

### Modified Capabilities
- `harness-providers`: The conformance kit SHALL also pass against the Grok Build provider with its fixture driver (Claude Code remains the first reference). `watchFile` SHALL follow the path (parent directory + filename), not the file inode, so an atomic rewrite keeps delivering.

## Impact

- New code: `src/providers/grok-build/**`, `src/testing/grok-driver.ts`, `test/providers/grok-build/**`, `test/fixtures/grok-build/`, live/e2e helpers for `grok`.
- Helper change: `src/helpers/watch-file.ts` (and its tests) so every caller, not only Grok, survives tmp-then-rename on Linux.
- `src/index.ts` adds `grokBuild` to `builtInProviders` and re-exports it. Pack test and README type snippets import it.
- Neutrality test: core still must not mention `.grok` / `GROK_HOME`; providers still must not import `node:fs`.
- README: Grok Build section parallel to Claude Code; keywords; non-goal "inferring status from journals" stays — Grok's status source is `events.jsonl`, not chat history.
- Runtime reads only `<home>/active_sessions.json` and `<home>/sessions/<encoded-cwd>/<id>/{summary.json,events.jsonl,chat_history.jsonl,subagents/**}`. It never opens `active_sessions.lock`, `*.tmp`, `auth.json`, `terminal/*.log`, or the session-search sqlite.
- No new runtime dependencies. Live tests need `OPENROUTER_API_KEY` and a `grok` binary, skipped by default like Claude.
- Windows remains out of scope.
