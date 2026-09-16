## Context

The repo contains only the README (the API draft) and a stub `package.json`. The README is the source of intent. The specs in this change are the contract. Claude Code 2.1.x on this machine writes the following:
- `~/.claude/sessions/<pid>.json`, plus a `.key` sibling
- `~/.claude/projects/<encoded>/<uuid>.jsonl`
- `<uuid>/subagents/agent-*.jsonl`

Session files also carry `procStart`, `updatedAt`, `kind`, `entrypoint`, and `messagingSocketPath`. We do not rely on `procStart` because its format is locale-dependent. The observed journal record types are:
- `user`, `assistant`, `system/turn_duration`: conversation
- `ai-title`, `custom-title`, `last-prompt`: metadata
- `system/agents_killed`: every open subagent was stopped
- `relocated` (`relocatedCwd`): the journal moved to another project directory
- `queue-operation`: queued input, whose `content` can carry a task notification
- `attachment`, `permission-mode`, `mode`, `file-history-snapshot`, `file-history-delta`, `atis-latch`, `bridge-session`, `worktree-state`, `system/compact_boundary`, `system/stop_hook_summary`, `system/away_summary`: bookkeeping

Claude Code honours `CLAUDE_CONFIG_DIR` as its home, so the provider defaults to it.

## Goals / Non-Goals

**Goals:**
- Keep the core free of harness knowledge. Claude Code is one provider module that happens to ship in `builtInProviders`.
- Make every behavior testable offline against a fake `$HOME`, with deterministic fixtures and no real `claude` binary.
- Give future providers a conformance kit that works without changes to the kit.

**Non-Goals:**
- Providers other than Claude Code.
- Windows.
- Launching agents, sending input, IPC sockets, `.key` files.
- Inferring status from journals.
- Binding sessions to terminals or process trees. Consumers do that with `pid`.

## Decisions

**Layout.** Dependencies point one way: `providers → helpers → types`, and `core → types`. The core never imports a provider, and `index.ts` is the only file that imports both. A test walks `src/core/**` imports and fails on any `providers/` import or `.claude` string literal.

```
src/
  index.ts                 default export AllYourAgents, builtInProviders, types
  core/                    instance, live registry, event ordering/dedupe, merge for sessions()/get()
  provider/                Provider/WatchContext/ListContext/InspectContext types, normalized SessionEvent
  helpers/                 coalesce (debounce + ceiling), watchDir, watchFile, tailJsonl, local fs, local processes
  providers/claude-code/   paths.ts, session-file.ts, status.ts, journal.ts, list.ts, provider.ts
  testing/                 conformance kit (exported as all-your-agents/testing)
```

**Language and tooling.**
- TypeScript compiled with `tsc` to ESM in `dist/`.
- Node ≥ 20, which is needed for stable recursive `fs.watch` on Linux and `Object.groupBy`.
- `node:test` + `node:assert` run against the compiled output. Biome for lint/format.
- Zero required runtime dependencies. `koffi` is optional and only backs `processes.watch`. Chokidar was rejected because it falls back to polling, and the watch semantics we need are narrow and must stay auditable against ADR 0001.

**Providers report facts, the core derives events.** Providers emit create/open/status/update/close for each id. The core owns:
- the live map
- per-id ordering
- dedupe of status and metadata
- the `catchUp` flag
- `ready`, which fires once every provider's `watch()` promise has resolved

The alternative was to let each provider manage dedupe and ordering. It was rejected because every provider would re-implement it slightly differently, which is the drift this library exists to remove.

**Never poll (ADR 0001, `docs/adr/0001-never-poll.md`).** Every read after the first is caused by a kernel notification for that path or a sibling, or by a consumer calling `reconcile`. No timer exists while nothing changes. This is enforced by the no-timers test, the conformance kit, and a lint rule banning `setInterval` outside `helpers/debounce.ts`.

**Injected environment.** The instance takes `{ fs, processes, debounce }` and passes them to every provider context. `fs` is a small interface: `readFile(path, { maxBytes })`, `readRange(path, start, end)`, `readDir`, `stat`, `watch(path)` returning an async iterator of raw notifications. `processes` is `{ info(pid), watch(pid) }`. Providers never import `node:fs`; the neutrality test checks this. The defaults wrap `node:fs` and the local process facilities. Terminay supplies its own `fs` that brokers over SSH, which is how remote agents get observed without a second code path. Tests pass a fake `processes`, so recycled-pid and ±5 s tolerance cases need no real processes. The local `processes.info`:
- macOS uses `ps -o lstart= -p <pid>`, with `LC_ALL=C` so the date parses.
- Linux uses `/proc/<pid>/stat` field 22 plus boot time.

It runs once per bind and on `reconcile`, never on a schedule.

**Process exit.** `processes.watch(pid, onExit)` is the event source for a process dying without cleaning up. Node has no built-in API for a foreign pid's exit (nodejs/node#19207 is still open), but the kernel facilities are one FFI call away, and `koffi` (MIT, Node-API 8, prebuilt for macOS/Linux x64+arm64, no compiler at install) reaches them without us writing C. Verified on this machine: `kevent` with `EVFILT_PROC | NOTE_EXIT` on a pid Node did not spawn, called through `kevent.async` so it blocks a libuv worker rather than the loop, fires at the exit with no timer anywhere.
- macOS: one `kqueue()` for the instance; `EV_ADD | EV_ONESHOT` per watched pid with `NOTE_EXIT | NOTE_FORK | NOTE_EXEC`; a single `kevent.async` loop drains it and re-arms.
- Linux: `syscall(SYS_pidfd_open, pid, 0)` then one `epoll` (or `poll.async`) over all pidfds; readable means exited. Kernel ≥ 5.3.
- The blocking call lives on its own `worker_threads` Worker, not the shared libuv pool, so it never starves `fs` work. One worker per instance, stopped on `stop()`.
- `koffi` is an `optionalDependency`. If it is absent or fails to load (unsupported platform, sandbox), `processes.watch` returns `unsupported` and the provider re-validates every bound pid whenever any `sessions/` entry changes and whenever the consumer calls `reconcile`. Both paths satisfy the ADR.
- Electron: Node-API modules are ABI-stable across Electron versions, so no `electron-rebuild`; the `.node` file must be listed in `asarUnpack`. Terminay already ships `node-pty` this way.
Claude Code removes its session file on normal exit, so this only matters for crashes and `kill -9`. Terminay owns the pty and may still call `reconcile(pid)` from its own facts; it is harmless when the exit watch already fired.

**Debounce with a ceiling.** One helper, `coalesce(quietMs = 25, maxLatencyMs = 1000)`, used by every watch. Per path it keeps `{ timer, firstPendingAt }`. On a notification: set `firstPendingAt` if unset, cancel the timer, and arm it for `min(quietMs, maxLatencyMs − (now − firstPendingAt))`. On fire: clear both and service the path once. A path notified 30 times a second is serviced once a second; a single notification is serviced after 25 ms; an idle path has no timer. Both numbers are instance configuration.

**Watching `sessions/`.** A non-recursive `fs.watch` on the directory through the coalescer. Each serviced entry re-reads that one file. Deletion is decided by whether the file exists after the burst, not by the event type, because macOS reports renames inconsistently. When the directory is missing, the helper watches the nearest existing ancestor and re-arms step by step as each level is created.

**Journal relocation.** A session-file rewrite that keeps `sessionId` but changes `cwd` means Claude Code has moved the journal (it writes a `relocated` record and moves the file to the new project directory, as happens on entering a worktree). The provider re-resolves the journal by id. If the path changed, it swaps the tail and the `subagents/` watch, replays the new file silently through the same reducer, and keeps the session open. Silent replay plus the `statusUpdatedAt` cutoff means finished subagents and tools are not re-opened. If the journal has not moved yet, the old tail keeps running and the next `sessions/` or `projects/` event re-runs the lookup.

**Title precedence.** The core holds one slot per source (`user`, `harness`, `process`, `prompt`) and computes the effective title as the highest set. The Claude provider maps `custom-title` → `user`, `ai-title` → `harness`, the session file's `name` → `process`, and the first real prompt → `prompt`. `session:update` fires only when the effective title changes.

**Tailing journals.** `tailJsonl` keeps a byte offset and a partial-line buffer, and reads appended bytes when `fs.watch` fires on the file. If the size drops below the offset, it resets to 0. The watch is attached before the initial read, and the read runs to EOF, so appends made during replay are not lost.

**Journal resolution.** First try the derived path. On a miss, list `projects/*` once and check for `<id>.jsonl` in each directory. That is a bounded `readdir` of depth one, with no recursive walk. If more than one directory has it, report no journal. Accept a candidate only if its first identifying record's `sessionId` matches and it is not `isSidechain`.

**History listing.** Stream each root journal, read metadata from the head, and read the last timestamp from a bounded tail read (last ~64 KB). Do not parse whole files. `get(id)` asks each provider's `list` with an id hint, so the Claude provider uses the same bounded lookup instead of listing everything.

**Activity is a reducer.** Turn facts go through a pure reducer, `(activity, fact) → activity`, in the core. Providers only decide which harness records are which facts. At bind, the provider replays the journal through the same reducer in silent mode and emits one `session:activity` with the result. This separation handles the known failure modes: a stuck "working" state, an error lost on idle, and replay flooding consumers. Each of those becomes a table test on the reducer or on the Claude fact mapper. `status` and `activity` are never merged. When the session file says `idle`, the provider closes an open turn, but it never sets status from the journal.

**Subagents.** Observed in Claude Code 2.1.x:
- `subagents/agent-<agentId>.meta.json` holds `{ agentType, description, toolUseId, spawnDepth, requestShape }`.
- A background launch's `tool_result` says "Async agent launched".
- Completion arrives later as a user record with `origin.kind: "task-notification"` and `<tool-use-id>` / `<status>` tags.
- Background shell commands use the same notification shape, so matching by tool-use id against known subagents is mandatory.

The provider keeps a per-session `toolUseId → subagent` map, filled from either source. `subagent:start` is emitted only when the id is first inserted, so the meta file and the tool use together produce one start. For live sessions, the `subagents/` directory is watched with `watchDir`, and nested launches are found by tailing each open subagent journal. When a subagent ends, its journal tail stops. Ending on idle applies only to foreground subagents. The old approach, "idle cancels every open child", is wrong for background agents, which keep running while the root sits idle.

**Headless.** No session file means history only. `kind` comes from `entrypoint` (`cli` → interactive, `sdk-cli` and others → headless).

**Record mapping.** The mapping is a pure function `(record) → SessionEvent | undefined`, covered by table tests. User text beginning with injected wrappers (`<system-reminder>`, `<command-name>`, `<local-command-`, `<task-notification>`) is not a prompt.

**Test layers.**
1. Pure unit tests: path encoding, status mapping, session-file validation, record mapping.
2. Helper tests on a real temp directory: watchDir create/rewrite/rename/delete/missing-dir, tailJsonl partial lines and truncation.
3. Provider tests: a fixture driver writes session files and journals into a temp `home`, uses a fake `processInfo`, and asserts on the event stream.
4. The conformance kit run against both the in-memory provider and Claude Code.
5. A captured fixture from a real 2.1.x session, scrubbed of prompt content and checked in with expected outputs.
6. A packaging test: `npm pack`, install into a temp dir, import `all-your-agents` and `all-your-agents/testing`.
7. An opt-in live smoke test (`AYA_LIVE=1`) that starts a real `claude` and waits for create→status→close. It is not run in CI.

A "no timers" assertion wraps `setInterval`/`setTimeout` during idle windows and fails on any timer at all; the coalescer's timers are only ever pending between a notification and its serviced read, so an idle window has none. A coalescer test drives 30 notifications a second for 10 s through a fake clock and asserts about 10 reads, and drives one notification and asserts a read at 25 ms.

8. A process-exit test: with `processes.watch` faked, an exit event closes the session; with it `unsupported`, a `sessions/` sibling change and a `reconcile(pid)` each close it, and a fake clock advanced with nothing changing closes nothing.

## Risks / Trade-offs

- [Claude Code changes its session-file schema] → Validation fails closed. A compat test pins the documented field set against the captured fixture, and `version` is recorded so the fixture can be refreshed per release.
- [`fs.watch` drops or merges events under load] → Every event re-reads the whole file, so state converges on the next notification. A lost unlink is caught when a later `sessions/` event triggers a rescan of that directory's entries.
- [Recursive watch differences between macOS and Linux] → No recursive watches. Only `sessions/` and individual journal files are watched.
- [Process start-time probe cost via `ps`] → It runs once per bind, not per status change.
- [Debounce hides a fast status flip, e.g. busy→idle within 25 ms] → Accepted. Consumers see the settled status, which is the point of status.
- [`koffi` missing or unloadable, so `processes.watch` is unsupported] → The session stays `running` until the next `sessions/` event or a `reconcile`. Claude Code cleans up on normal exit and terminay calls `reconcile` from its own process facts, so the gap is crashes on a platform without the prebuilt.
- [`koffi` prebuilt ABI drifts from a future Node/Electron] → Node-API is stable; the load is wrapped and falls back to `unsupported`, so a broken binary degrades rather than crashes.
- [The latency ceiling delays a single important write behind a flood] → Bounded to `maxLatencyMs`, and only when the same path is being hammered. A different path is unaffected because coalescing is per path.
- [A supplied remote `fs` drops notifications] → Same as local: every serviced read re-reads the whole target, so the next notification converges.
- [Claude changes the task-notification or meta.json shape] → Parsing is limited to the documented tags and fields and fails closed, so a subagent stays `running` until its session closes, when it is cancelled. The captured fixture pins the shape.
- [A background subagent whose notification never arrives] → It is cancelled on session close. It is not ended on a timer.
- [Many open subagent journals tailed at once] → One watcher per running subagent, released on end. Ended subagents are never tailed.
- [History listing on thousands of journals is slow] → Head and tail reads are bounded. `since` short-circuits on file mtime before parsing.

## Open Questions

- Whether to expose the raw Claude `version` on `Session` as a generic `harnessVersion`. It is additive and can be decided when a second provider exists.
- Whether the `koffi`-backed `processes` implementation should live in a separate package (`@all-your-agents/proc`) so the main package stays pure JS, or stay in-tree behind `optionalDependencies`. Leaning in-tree: it is one file and the fallback is already required.
