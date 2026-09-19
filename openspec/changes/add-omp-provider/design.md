## Context

See proposal.md for why. Three providers, their fixture drivers, the conformance kit and `AYA_LIVE=1` e2e already exist. The core and ADRs stay unchanged; the helpers gain three optional pieces.

Layout is pinned to `/Users/mark/Documents/Projects/oh-my-pi` @ `78b7531` (`@oh-my-pi/pi-coding-agent` 18.2.6, paths below relative to `packages/coding-agent/src`). Everything marked **live** was observed on 2026-09-19 by running `omp --model grok` in a terminal while logging every change under `~/.omp` (a recursive watch plus a 100 ms stat sweep, for the experiment only).

**ADR 0002 evidence: omp keeps a registry, in two parts.**

- Presence: `run/daemons/<16-hex hash of canonical cwd>/clients/<pid>-<uuid>.json` = `{"pid":18510,"id":"18510-…","projectDir":"/private/tmp/…/proj"}` (`launch/presence.ts:36-57`, called from `main.ts:2046`). **Live:** created about 100 ms after launch, deleted on `/exit`. `omp -p` also writes it (the `clients` directory's mtime moved during a 4 s print run). After SIGKILL it stays.
- Breadcrumb: `agent/terminal-sessions/<terminal-id>`, three or four lines: cwd, session file path, optional `fresh`, `cwdstat <dev> <ino>` (`session/session-paths.ts:308-330`). The id is the stdin tty path minus `/dev/` with `/` → `-` (`ttys024`, `pts-3`), and only falls back to `zellij-…`/`tmux-…`/`kitty-…`/`apple-…` when stdin is not a tty (`tui/src/ttyid.ts`). **Live:** written in the same burst as the presence file, with `fresh` and a session path that does not exist yet; rewritten without `fresh` when the transcript materialises; rewritten on session switch. Never deleted. `omp -p` writes one too when its stdin is a tty (checked on 18.2.6), and none when it is not. Subagents never write one (`task/executor.ts:3619`).
- Neither holds status, and neither alone joins pid to session. `ps -o tty= -p <pid>` does.

**Transcript.** `agent/sessions/<encoded-cwd>/<ISO-ts>_<uuidv7>.jsonl`. Line 1 is a fixed 256-byte title slot overwritten in place; line 2 the `session` header (`version` 3, `id`, `timestamp`, `cwd`, optional `parentSession`, `title`). Entries carry `id`, `parentId` (a tree), `timestamp`. The cwd encoding is lossy (`/tmp/x` and `/private/tmp/x` differ between presence, breadcrumb and directory name), so cwd always comes from the header or breadcrumb.

- **Lazy creation** (`session-manager.ts:1115`, `:1305`): no file until the history holds an assistant message. **Live:** prompt at 08:31:51.5, file at 08:32:08.2.
- After that, the user message is appended at submit (**live:** 08:32:21.9 for the second prompt), the assistant message at `message_end`, a `custom` `tool_execution_start` marker before each tool runs, `toolResult` after.
- The first write is a temp-file rename; later appends go through one fd opened `a` and kept open. **Live:** a directory watch saw none of the six appends (ADR 0002's macOS point) but did see the `.jsonl.lock` sidecar come and go. `tailJsonl` watches the file itself, so it is unaffected.
- Exit appends `custom` `session_exit` `{reason, kind}` to the root and to every child (**live**). SIGKILL leaves none.
- `history.db` (`session/history-storage.ts:112`): `history(id, prompt, created_at, cwd, session_id)`, WAL mode, held open. **Live:** the row for the first prompt was committed at submit, 17 s before the transcript existed; only the stat sweep saw the `-wal` write.
- Subagents: `<session-basename>/<AgentId>.jsonl` created at spawn with its own header (`parentSession` = parent file path), a `session_init` entry (`agent`, `task`, …), and the task prompt as a user message. **Live:** three files appeared together at spawn; each ended with a `yield` `toolResult` `{status:"success"}` 3–5 s later; `session_exit` was appended to each only at process exit. The parent's `task` `toolResult` came back within 1 ms with `details.progress[]` (`id`, `agent`, `status:"pending"`) and the parent then called `hub` `wait`.
- The per-pid log (`logs/omp.<date>.<pid>.log`) was checked as a first-turn signal and rejected: it logs no turn start, only incidental title-generator lines under a different session id.

## Goals / Non-Goals

**Goals:**
- Discovery from the registry only; transcripts are read for content (ADR 0002).
- Correct `running` from the first prompt of a new session, when SQLite is readable.
- The same conformance cases as the other three providers.

**Non-Goals:**
- Live binding of headless runs. They have no breadcrumb, and joining a presence pid to "the newest file in its cwd" is the guess ADR 0001 warns against.
- `waiting` for permission approvals (nothing on disk).
- Reconstructing the `parentId` branch tree; `transcript()` is file order.
- Collab, `omp stream`, broker daemons, upstream `pi`, Windows.

## Decisions

**1. Join presence to breadcrumb by tty, with a new `Processes.tty(pid)`.** The breadcrumb's name *is* the tty, so one `ps -o tty= -p` (macOS) or `/proc/<pid>/stat` field 7 → `/dev` name (Linux) is an exact join, made once per presence file, in response to its create event. Alternatives: join by cwd (ambiguous with two omp in one directory, and `/tmp` vs `/private/tmp` differ); `holders(transcript)` as Codex does (no file for the whole first turn, and no fd until the second write). The probe is optional like `holders`; without it the provider is history-only.

**2. Watch both halves of the registry.** `terminal-sessions/` is flat (one watch). `run/daemons/<hash>/clients/` is per-project, so the tree is walked as Codex's date tree is: one watch on `run/daemons`, one per `clients` directory, added as they appear. Either half can be serviced first, so binding is attempted from both sides and succeeds when both exist: a presence create looks for a breadcrumb named after its tty; a breadcrumb create/change looks for a live presence pid with that tty. A bound map keyed by session id, plus pid → session id and tty → pid. Stale empty `clients` directories accumulate one watch each; on this machine that is a few dozen.

**3. Breadcrumb freshness guard.** A breadcrumb older than its process (minus 5 s) is not that process's: omp rewrites it at every launch and switch, so an older one means this process runs in a mode that does not write breadcrumbs. Same slack the Claude provider uses for start-time checks.

**4. First turn from `history.db`, through an injected reader.** Rejected alternatives: accept `idle` for the first turn (the longest-feeling gap in the UI is exactly a new session's first prompt); read the log (no signal). The reader is `sqlite?: { query(path, sql, params): Promise<Row[]> }` on the three contexts and `InstanceOptions`, defaulting to a wrapper over `node:sqlite` found by dynamic import (absent below Node 22.13; `engines` stays `>=20`). It opens read-only per call and closes, so aya is never a standing holder and never pins the WAL. Decided with the user during the OpenCode round and reused here. The provider keeps a `max(id)` cursor read once at start and queries `WHERE id > ?` on each `-wal` notification: a targeted read, never a scan on a clock.

**5. `watchFile(path, cb, { heldOpen: true })`.** `watchFile` deliberately watches the parent so rename-replaces keep delivering; that is blind to held-open writes on macOS. With the option it additionally attaches a watch to the file itself and re-attaches when the parent reports the name created or replaced. Checked: `fs.watch` on a `-wal` file held by another process fired on all five commits while the directory watch fired on none.

**6. One reducer for the transcript, fed from two sources.** A pure reducer over entries produces status, turn facts, title, model (like `codex-cli/events.ts`). A history row is translated into a synthetic "turn started by prompt P" input; when the transcript's backlog arrives, its first user message is matched to the open synthetic turn instead of starting another. After materialisation history rows are dropped for that session.

**7. Session's directory watch, filtered.** Per bound session, `watchDir` on the transcript's parent catches (a) the transcript appearing, (b) a rename-replace (then: close tail, re-open, silent replay), (c) the artifact directory appearing. Events are filtered by the two names, so `.lock` churn and sibling sessions cost a string compare. The `.lock` sidecar is never opened.

**8. Subagent ids are omp's AgentIds; completion is `yield` or the parent's report.** The transcript's file name is what the parent's `task` result calls the agent (`PowTwoTen`; nested: `NestParent.MulChild`, in `NestParent/`), so it links tool call and child without a second key, and parents are matched by file name because omp canonicalises paths and a breadcrumb may not. A live run showed a child recording `stopReason: stop` *before* yielding: omp reminds an agent that stops without `yield` (up to three times) and it carries on, so a bare `stop` is not an end. The parent's own word (`hub` `jobs[]`, `task` `results[]`, an `async-result` note) is a second source, first one wins, as the Codex provider does with `wait`. `session_exit` only arrives at process exit, so it is the `cancelled` fallback. `background` is omp's own flag (`details.async` on the `task` result), read when the subagent starts: the core fixes `background` at `subagent:start` and has no way to revise it, so the Codex rule (flip when the parent's turn ends) would never be visible.

**9. Profiles are extra roots.** A root is `{ agentDir, runDir }`. The provider runs the same watch set per root and merges by session id.

## Risks / Trade-offs

- [omp changes `history` or drops it] → one `reportError`, first-turn detection off, everything else unaffected. A compat test pins the columns we read.
- [A retry loop after a provider error sits between `error` and the next assistant message with nothing on disk] → reads `idle`/`failed` during the back-off. Accepted; it is what the disk says.
- [Two omp processes on one tty (one started from the other's `!` shell)] → the newer one owns the breadcrumb; the older is unbound until it rewrites it. Matches what the terminal shows.
- [`tty` name mapping on Linux (`pts/3` vs device numbers)] → resolved by the helper; covered by a test that spawns a child on a pty.
- [Watch count grows with `run/daemons/*`] → directories only, no fds on transcripts; revisit if it passes a few hundred.
- [Branching (`/tree`) makes file order differ from the visible conversation] → status still follows the last appended record, which is the active branch's tip.
- [Non-tty terminal ids (`tmux-%3` when stdin is not a tty)] → ignored; such a process has no tty to join on.

## Migration Plan

Additive. `builtInProviders` grows by one; a machine without `~/.omp` costs the ancestor watches only. Rollback is removing the provider from the array.

## Resolved during implementation

- Nested subagents' transcripts land in `<artifacts>/<Parent>/<Parent>.<Child>.jsonl`, with `parentSession` naming the parent's transcript (captured in `test/fixtures/oh-my-pi/18.2/nested*`).
- omp's XDG redirect applies on macOS as well as Linux, and only once `$XDG_*/omp` exists (`utils/src/dirs.ts:352`).
- Detecting a rename-replace needs the inode, which `FsStat` did not carry; it gained an optional `ino`.
- The live tests run omp under a scratch `$HOME` whose `.omp/agent/config.yml` puts every model role on `openrouter/anthropic/claude-sonnet-5` and marks first-run setup done (`setupVersion: 2`); omp reads `OPENROUTER_API_KEY`, so no sign-in is needed and CI runs them with the other live tests. Interactive omp is driven on a pty by `test/e2e/omp-pty.py`; `script` forwards EOF from a closed stdin and omp quits on it.
- `stopReason: aborted` could not be provoked through the terminal driver for a root transcript; that one fixture is synthetic and marked so. (It was later seen for real in a subagent killed mid-reply.)
