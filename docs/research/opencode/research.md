# OpenCode research (parked 2026-09-19)

Parked by decision: wait for opencode v2 to become the default, then build against it. No proposal, specs, design or tasks were written. `questionnaires/design-decisions.yaml` holds the answers given for a 1.x design.

## opencode 1.x (checked: source `34b4c3c`, installed 1.18.31, real data, a live idle TUI)

- Everything is in one SQLite WAL database, `~/.local/share/opencode/opencode.db` (`OPENCODE_DB` overrides; XDG dirs). Tables `session`, `message`, `part` (JSON `data` columns), plus an append-only `event` table whose `rowid` works as a global change cursor. Sessions older than the event log have no event rows. The JSON `storage/` layout is gone.
- No registry (ADR 0002 evidence): no pid file, lock, or port file. `~/.local/state/opencode/locks/` is empty during a live TUI. No pid column anywhere; `event_sequence.owner_id` is a sync-replay owner and is NULL on every row. `OPENCODE_PID` is an env var only. Session busy/idle and pending permission asks are in memory only.
- An idle TUI holds `opencode.db`, `-wal`, `-shm` and the shared `log/opencode.log` open (lsof). The process chdirs to the project, so cwd equals `session.directory`. argv carries `-s ses_…` only when the user passed it. The log tags lines with a per-process `run=<8hex>` and never records the pid.
- A file-level `fs.watch` on `opencode.db-wal` fires per commit while another process holds it; a directory watch reports nothing (tested with sqlite3 + node). A read-only second connection is safe. The WAL file survives process exit.
- Status from rows: a turn is open when the newest assistant message has no `time.completed`, or a user message is newer than the last assistant message. `finish` is `stop` / `tool-calls` / `length` / `unknown`; errors carry `error.name` (`MessageAbortedError`, `APIError`, …). A hard kill leaves tool parts `running` forever; nothing repairs them.
- Subagents: child `session.parent_id`; the parent's `task` tool part has `state.metadata.sessionId` from the moment it is `running`. Children run in the same process.
- IDs embed a 48-bit timestamp that wraps about every 795 days (a wrap happened 2026-08-14). Order by `time_created`, never by id.
- A 1.x design would need: an injected SQLite reader, a one-time cwd/argv probe per pid, and inference for pid → session that is ambiguous when two processes share a cwd.

## opencode v2 (public beta 2.0.x, binary `opencode2`; code on `dev` under `packages/cli`)

- One shared background daemon owns every session. It writes `~/.local/state/opencode/server.json` = `{ id, version, url, pid }` and a `password` file beside it (`packages/cli/src/services/daemon.ts`). TUI and `run` are clients.
- That is a real registry for the daemon, and its SSE stream (`/event`) pushes session status, permission asks and message updates. Subscribing is event-driven (ADR 0001 holds) and would give `waiting`. It would be the first provider that reads a local HTTP stream rather than files, so the injected `fs` contract needs a small network counterpart.
- One long-lived pid means process exit no longer says which sessions are live; liveness would come from the stream.
- GitHub issue #47497's `session.json` is the TUI's pinned-session list (`{ pinned: [...] }`); the `<pid>` there is only in the atomic-rename temp name.
- State on 2026-09-19: npm `latest` is 1.18.31; v2 issues run at about 50 a month (importer, upgrade, plugin bugs). No announced date.

## Side effect to remember

Invoking the `opencode` binary triggers its auto-upgrade (1.18.29 → 1.18.31 happened during this research).
