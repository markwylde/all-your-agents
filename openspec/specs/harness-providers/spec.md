# harness-providers Specification

## Purpose

Defines the contract a harness provider implements, so every coding-agent CLI can plug into the same session API without leaking its filesystem layout into the core.

## Requirements

### Requirement: Provider contract
A provider SHALL declare an `id` and a `harness` name, and SHALL implement `watch(ctx)`, which returns an unwatch function or a promise of one. It MAY implement `list(ctx)`, yielding historical session snapshots, and `inspect(ctx, id)`, yielding normalized session events. The core SHALL treat a missing `list` or `inspect` as "no history" rather than as an error.

#### Scenario: Watch-only provider
- **WHEN** a provider implements only `watch`
- **THEN** its live sessions appear in events and `running()`, `sessions()` returns only those live sessions for it, and `transcript()` yields nothing

### Requirement: Providers report facts, the core derives events
A provider SHALL report live state through `ctx.emit` using the session verbs. The core SHALL deduplicate repeated status and metadata, enforce per-id ordering, maintain the live set, and set the `catchUp` flag. Providers SHALL NOT decide `catchUp`.

#### Scenario: Provider repeats a status
- **WHEN** a provider emits `session:status` with an unchanged status
- **THEN** consumers receive nothing

#### Scenario: Provider signals initial scan done
- **WHEN** a provider's `watch` promise resolves
- **THEN** the core treats that provider's initial snapshot as complete for the purpose of `ready`

### Requirement: Activity and subagent facts
A provider SHALL report turn facts (turn started, tool started, tool finished, turn ended with completed/failed/interrupted and optional error message) and subagent facts (subagent started, subagent ended with a final status) through `ctx.emit`. The core SHALL fold turn facts into `session.activity`, maintain `openSubagents`, dedupe, and apply the ordering rules. The core SHALL cancel open subagents when their session closes. Providers own every harness-specific decision about what counts as a turn end, a failure, a foreground subagent cut off by idle, or a subagent completion.

#### Scenario: Duplicate subagent end
- **WHEN** a provider reports `subagent ended` twice for one id
- **THEN** consumers receive one `subagent:end`

#### Scenario: Subagent end without start
- **WHEN** a provider reports an end for a subagent id it never started
- **THEN** nothing is emitted

#### Scenario: Watch-only provider without activity
- **WHEN** a provider reports no turn facts
- **THEN** `activity` is `{ openSubagents: 0 }` and no `session:activity` fires

### Requirement: Event-driven only
Per ADR 0001 (`docs/adr/0001-never-poll.md`), providers and helpers SHALL discover changes only through operating-system notifications: filesystem watches (fs.watch, FSEvents, kqueue, inotify) and process events (kqueue `EVFILT_PROC` on macOS, `pidfd`/netlink process connector on Linux). They SHALL NOT use interval timers to re-read paths, re-run commands, or scan the process table. A one-time system call made in direct response to an event (for example reading a pid's start time when a session file appears) is allowed. A path SHALL be re-read only because a notification named it or a sibling in the same watched directory.

#### Scenario: No timers while idle
- **WHEN** an instance has started and nothing on disk or in the process table changes
- **THEN** no timer of any kind is armed anywhere in the core, helpers, or providers

#### Scenario: Reaction is targeted
- **WHEN** one session file among fifty changes
- **THEN** only that file is re-read, and no journal or other session file is touched

### Requirement: Debounce with a latency ceiling
Every watch helper SHALL coalesce notification bursts per path with a trailing quiet window (default 25 ms), restarted by each further notification for that path, and SHALL enforce a maximum latency (default 1000 ms) after which the path is read even if notifications have not stopped. Both values SHALL be configurable on the helper. A debounce timer SHALL exist only between a notification and its serviced read.

#### Scenario: Burst coalesced
- **WHEN** a file receives 100 notifications within 200 ms and then goes quiet
- **THEN** it is read once, about 25 ms after the last notification

#### Scenario: Continuous writer is not starved
- **WHEN** a file is written 30 times a second for 10 seconds
- **THEN** it is read about once a second throughout, roughly 10 reads, not 300 and not 0

#### Scenario: Single write is prompt
- **WHEN** one notification arrives and nothing follows
- **THEN** the read happens within the quiet window, not after the ceiling

### Requirement: Process liveness is event-driven
A session bound to a pid SHALL be closed when that process exits, without polling. The `WatchContext` SHALL expose `processInfo(pid)` for the one-time probe and `watchProcess(pid, onExit)` for exit notification. `watchProcess` SHALL be implemented with a kernel process-event facility where one is available. Where it is not, it SHALL report `unsupported`, and the provider SHALL re-validate the pid only when another event for that session fires (session-file rewrite, journal append, or a sibling entry in the sessions directory changing). The core SHALL expose `reconcile(pid?)` so a consumer with its own process facts can request one re-validation; this is an event from the consumer, not a schedule.

#### Scenario: Process killed without cleanup
- **WHEN** a live process is `kill -9`ed and its session file remains on disk
- **THEN** `session:close` fires from the process exit event, with the stale file ignored thereafter until it is rewritten by a validated process

#### Scenario: Reconcile from the host
- **WHEN** `watchProcess` is unsupported and the consumer calls `reconcile(pid)` after observing the process exit
- **THEN** the pid is checked once, `session:close` fires, and no timer is armed

#### Scenario: Stale file on a later event
- **WHEN** `watchProcess` is unsupported, a process died leaving its file, and another entry in `sessions/` later changes
- **THEN** the dead pid's file is re-validated as part of servicing that event and its session is closed

### Requirement: Injected filesystem
All file access in providers SHALL go through the `WatchContext`/`ListContext`/`InspectContext` file interface (`readFile`, `readDir`, `stat`, `open` for bounded ranges, `watchDir`, `watchFile`, `tailJsonl`), never `node:fs` directly. The default implementation is the local filesystem. A consumer MAY supply another implementation (for example one that brokers to a remote machine over SSH) and every requirement in this change SHALL hold against it, provided it delivers change notifications.

#### Scenario: Remote home
- **WHEN** an instance is created with a file interface that reads a remote `~/.claude` and forwards its notifications
- **THEN** sessions on that machine are emitted exactly as local ones, and no local path is touched

#### Scenario: Provider bypasses the interface
- **WHEN** a provider imports `node:fs`
- **THEN** the neutrality test fails

### Requirement: Shared watch helpers
The package SHALL provide helpers that providers use instead of writing their own watchers.
- `watchDir(path, onChange, { quietMs, maxLatencyMs })`: performs an initial scan, reports create/change/delete per entry, decides create/delete by existence after the burst rather than by event type, and coalesces bursts per entry.
- `watchFile(path, onChange, { quietMs, maxLatencyMs })`
- `tailJsonl(path, { backlog? })`: yields complete JSON lines from a byte offset, then appended lines, reading only on notification.
- `processInfo(pid)`: one-time `{ alive, startTime? }` probe.
- `watchProcess(pid, onExit)`: process exit notification, or `unsupported`.

When a watched directory does not exist, `watchDir` SHALL watch the nearest existing ancestor and begin watching once the directory appears, re-arming one level at a time. `watchDir` SHALL open its watch before it performs the initial scan, so an entry created while the scan runs is reported, and SHALL report each entry's creation once. When the watched directory is removed, `watchDir` SHALL report a delete for every entry it knew and re-arm as for a missing directory.

`tailJsonl` SHALL read each byte of the file once. With `backlog: 'separate'`, the complete records present when the tail opens SHALL be delivered together through the handle's `backlog` promise and SHALL NOT be yielded by iteration, which then yields only later appends; this lets a caller tell stored records from live ones without reading the file twice. `tailJsonl` SHALL decode UTF-8 across read boundaries, so a multi-byte character split between two reads is yielded intact. When reading the tailed file fails, iteration SHALL end by throwing that error, so the caller can report it; it SHALL NOT surface as an unhandled rejection.

A helper SHALL NOT open a watch after it has been closed, whatever it was awaiting at the time.

#### Scenario: Directory created later
- **WHEN** `watchDir` is called on a missing directory and that directory is then created with a file inside
- **THEN** a create is reported for that file without polling

#### Scenario: Atomic rewrite
- **WHEN** a watched file is replaced by writing a temporary file and renaming it over the original
- **THEN** a single change is reported and no delete is reported for that entry

#### Scenario: Truncated journal
- **WHEN** a tailed JSONL file shrinks
- **THEN** `tailJsonl` restarts from offset zero instead of yielding corrupt lines

#### Scenario: Entry created during the initial scan
- **WHEN** an entry is created in a watched directory after the watch is open and before the initial scan has listed it
- **THEN** exactly one create is reported for it

#### Scenario: Directory removed and created again
- **WHEN** a watched directory holding one entry is removed, then created again with a new entry
- **THEN** a delete is reported for the old entry and a create for the new one, without polling

#### Scenario: Backlog delivered separately
- **WHEN** a file holding two records is tailed with `backlog: 'separate'` and a third record is then appended
- **THEN** `backlog` resolves with the first two records, iteration yields only the third, and the first two were read from disk once

#### Scenario: Two levels missing
- **WHEN** `watchDir` is called on `<home>/sessions` while `<home>` does not exist, then `<home>` is created with another file in it, then `<home>/sessions` with an entry
- **THEN** the only change reported is the create of that entry in `<home>/sessions`

#### Scenario: Closed while starting
- **WHEN** `watchDir` is closed while its initial scan, or its walk up to an existing ancestor, is still in progress
- **THEN** no watch is left open and no change is reported

#### Scenario: Read failure
- **WHEN** reading a tailed file fails
- **THEN** iteration ends by throwing that error

#### Scenario: Character split across reads
- **WHEN** a line containing a multi-byte character is written in two parts that split that character, with a read between them
- **THEN** the record is yielded once, complete, with the character intact

### Requirement: Normalized session events
Providers SHALL map harness records into these normalized kinds:
- `user` (text)
- `assistant` (text, model)
- `tool` (id, name)
- `tool-result` (id, isError)
- `title` (title, source: `harness` | `user` | `prompt`)
- `turn-end`
- `subagent` (id, title, type, background)
- `subagent-end` (id, status)
- `error` (message)

Every item SHALL carry `raw` with the original record and `at` (epoch ms) when the record has a timestamp. Records with no mapping SHALL be skipped by `transcript()`. They MAY be yielded by `events()` as kind `other`.

`transcript()` SHALL group these into `Turn` objects: one per `user` prompt, holding the events up to and including its `turn-end` (or the next prompt), with `startedAt`, `endedAt`, and `outcome` (`completed` | `failed` | `interrupted` | `open`).

#### Scenario: Turn grouping
- **WHEN** a journal holds two prompts, each followed by assistant text and a `turn-end`
- **THEN** `transcript()` yields two `Turn`s with `outcome` `completed`

### Requirement: Title precedence
When more than one title source exists for a session, the core SHALL apply, highest first: a title the user set explicitly (`user`), a title the harness generated (`harness`), the session file's process name if the provider supplies one, and the first real prompt (`prompt`). A lower-priority source SHALL NOT overwrite a higher one already set. `session:update` SHALL fire when the effective title changes.

#### Scenario: Prompt does not replace a generated title
- **WHEN** a session has a harness title and a new prompt arrives
- **THEN** `title` is unchanged

#### Scenario: User title wins
- **WHEN** a session has a harness title and the user then sets a custom title
- **THEN** `title` becomes the custom title and a later harness title does not replace it

#### Scenario: Unmapped bookkeeping record
- **WHEN** a journal contains a bookkeeping record
- **THEN** `transcript()` skips it

### Requirement: Fail closed on bad input
Providers SHALL ignore malformed, oversized, or unvalidated session records instead of guessing. A rejected record SHALL NOT produce a session event.

#### Scenario: Malformed session file
- **WHEN** a session file contains invalid JSON
- **THEN** no event is emitted for it and the watch keeps running

### Requirement: Conformance kit
The package SHALL export a conformance kit that runs the lifecycle contract against any provider. The test author supplies a fixture driver that creates, rewrites, and removes that harness's files in a temporary home. The kit SHALL cover:
- catch-up and ready
- create vs open
- status dedupe
- conversation switch as close then open
- close retaining history
- stop releasing watches
- no timers while idle
- burst coalescing and the latency ceiling
- process exit closes the session (via `watchProcess` or `reconcile`)
- journal relocation keeps the session open and does not replay finished subagents
- title precedence
- activity: tool start/finish, turn completed, turn failed with the error standing through idle
- subagents: start, end, nested parent, background outliving the turn, cancel on close, catch-up of a running subagent

#### Scenario: Reference provider passes
- **WHEN** the conformance kit runs against the Claude Code provider with its fixture driver
- **THEN** every conformance case passes

#### Scenario: In-memory provider passes
- **WHEN** the conformance kit runs against a minimal in-memory test provider
- **THEN** every conformance case passes, proving the kit has no harness assumptions

### Requirement: Asynchronous failure reporting
The `WatchContext` SHALL expose `reportError(error)`. A provider SHALL use it for any failure that happens after `watch` has returned (for example while handling a tailed record) instead of throwing into a callback or discarding the error. The core SHALL emit each report as an `error` event naming that provider. A provider SHALL keep observing after it reports: one record that cannot be handled SHALL NOT end the tail it came from.

#### Scenario: Bad record does not end the tail
- **WHEN** handling one tailed record fails and further records are then appended
- **THEN** one `error` is emitted naming the provider, and the later records still produce their events

### Requirement: Inspect stops on request
When the core asks a provider to follow a session (`inspect` with `follow`), the `InspectContext` SHALL carry an `AbortSignal`. When it aborts, the provider SHALL stop following: release every watch it opened for that call and finish the iteration, even if it is waiting for the next record at that moment. A provider whose `inspect` does not follow MAY ignore the signal.

#### Scenario: Abort while idle
- **WHEN** a provider is following a journal that is not changing and the signal aborts
- **THEN** the iteration finishes and the journal is no longer watched
