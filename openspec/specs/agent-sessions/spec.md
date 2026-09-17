# agent-sessions Specification

## Purpose

The harness-neutral public API for watching live coding-agent sessions on the local machine and inspecting the sessions they leave behind.

## Requirements

### Requirement: Instance lifecycle
The system SHALL create an instance from a list of providers and optional `{ fs, processes, debounce: { quietMs, maxLatencyMs } }` overrides. Nothing is watched until `start()` is called. `start()` and `stop()` SHALL each be idempotent. After `stop()` resolves, no further events SHALL be emitted and every watch, file and process, SHALL be released. `stop()` SHALL forget every session that was live, together with its titles and subagents, so that a later `start()` catches up exactly as a new instance would. `stop()` called while `start()` is still in progress SHALL wait for it and then release everything it opened.

#### Scenario: Stop releases watches
- **WHEN** `stop()` resolves after a successful `start()`
- **THEN** no further events are emitted and every file and process watch is released

#### Scenario: Stop during start
- **WHEN** `stop()` is called before `start()` has resolved
- **THEN** both resolve, no watch is left open, and `running()` is empty

#### Scenario: Restart catches up again
- **WHEN** an instance is stopped while a live session has a running subagent, and `start()` is then called again
- **THEN** `session:open` or `session:create` and `subagent:start` are emitted for them with `catchUp: true` before `ready`

### Requirement: Never poll
The system SHALL follow ADR 0001 (`docs/adr/0001-never-poll.md`): every change is learned from a filesystem or process notification, bursts are coalesced per path with a bounded ceiling, and no timer exists while nothing is changing. This applies to the core, the helpers, and every built-in provider, and the conformance kit SHALL enforce it on custom providers.

#### Scenario: Idle instance holds no timers
- **WHEN** an instance has started and no watched file or process changes for any length of time
- **THEN** no `setTimeout` or `setInterval` is pending

### Requirement: Reconcile
The instance SHALL expose `reconcile(pid?)`. With a pid it SHALL re-validate that pid's session once; without one it SHALL re-validate every live session once. It SHALL be safe to call at any time and SHALL never schedule anything. It exists for consumers that learn of a process exit from their own facts (for example a terminal emulator that owns the pty).

#### Scenario: Host reports exit
- **WHEN** a consumer calls `reconcile(pid)` for a live session whose process has exited
- **THEN** `session:close` fires for it, and no other session is touched

#### Scenario: Nothing happens before start
- **WHEN** an instance is created and a provider's session file appears before `start()`
- **THEN** no event is emitted and no watch is open

#### Scenario: Repeated start
- **WHEN** `start()` is called twice
- **THEN** catch-up runs once and `ready` fires once

#### Scenario: Stop releases everything
- **WHEN** `stop()` resolves and a session file then changes
- **THEN** no event is emitted and no file handles or watchers remain open

### Requirement: Catch-up then ready
On `start()`, the system SHALL emit every already-live session as `session:create` or `session:open`, followed by `session:status` when a status is known, all with `{ catchUp: true }`. It SHALL then emit `ready` exactly once. Every later event SHALL carry `{ catchUp: false }`.

#### Scenario: Two sessions already live
- **WHEN** two sessions are live before `start()`
- **THEN** each is emitted with `catchUp: true`, then `ready` fires, and later changes carry `catchUp: false`

#### Scenario: No sessions live
- **WHEN** no sessions are live at `start()`
- **THEN** `ready` fires with no session events before it

### Requirement: Session lifecycle events
The system SHALL emit `session:create`, `session:open`, `session:status`, `session:update`, and `session:close`. Each carries the `Session` after the change as its first argument and `{ catchUp }` as its second. `session:status` SHALL fire only when the status value changes, including the first known status after create or open. `session:update` SHALL fire only when the effective title (see title precedence in harness-providers), cwd, or model changes. `session:activity`, `subagent:start`, and `subagent:end` are defined below and follow the same `{ catchUp }` rule.

#### Scenario: Status repeated
- **WHEN** a provider reports the same status twice in a row
- **THEN** only one `session:status` is emitted

#### Scenario: Close keeps history
- **WHEN** a live session closes
- **THEN** `session:close` fires with `pid` unset, and the same id is still returned by `sessions()` and `get()`

#### Scenario: Process dies uncleanly
- **WHEN** a live session's process exits without removing whatever file marked it live
- **THEN** `session:close` fires from the process exit notification, or from `reconcile`, and never from a timer

### Requirement: Event ordering per session
For a given session id, the system SHALL deliver events in order. `session:create` or `session:open` SHALL come first. No event for that id or its subagents SHALL follow its `session:close` until a new `session:create` or `session:open`. For a subagent, `subagent:start` SHALL precede `subagent:end`, and `subagent:end` SHALL fire at most once.

#### Scenario: Status never precedes open
- **WHEN** a session file appears already carrying a status
- **THEN** `session:open` or `session:create` is emitted before `session:status`

### Requirement: Session shape
Every emitted or returned session SHALL have `id`, `harness`, `provider`, and `activity`. It MAY have `pid`, `cwd`, `title`, `status`, `waitingFor`, `startedAt`, `updatedAt`, `kind` (`interactive` or `headless`), and `model` (the model that produced the most recent reply, as the harness names it). `status` SHALL be one of `running`, `waiting`, or `idle`, or be absent when the provider cannot tell. `waitingFor` SHALL be present only when `status` is `waiting`. `pid` SHALL be present only while a process holds the session. A field that is unknown SHALL be absent rather than present with an `undefined` value, whichever query or event returned the session.

#### Scenario: Unknown status omitted
- **WHEN** a provider cannot determine status
- **THEN** the session has no `status` field rather than a guessed value

#### Scenario: Same shape from every source
- **WHEN** the same live session is obtained from an event, from `running()`, from `sessions()`, and from `get(id)`
- **THEN** all four have the same own keys and values, and `activity` is a copy that later changes do not mutate

### Requirement: Session activity
Every session SHALL have an `activity` object describing what its current or last turn is doing, separate from `status`. It has these fields:
- `tool`: the tool call in progress (`id`, `name`, `startedAt`), or absent
- `lastTurn`: `completed`, `failed`, or `interrupted`, or absent before any turn has ended
- `lastTurnEndedAt`: epoch ms
- `error`: the most recent turn failure message, or absent
- `openSubagents`: the count of subagents still running

`session:activity` SHALL fire whenever any of these fields changes. A turn failure SHALL stay on `activity.error` until the next turn starts. Activity is derived from the transcript. It SHALL NOT change `status`, which comes only from the harness's own status source.

A turn ends once. After a turn has ended, further turn-end facts SHALL be ignored until a turn or a tool call starts: they SHALL NOT change `lastTurn`, `lastTurnEndedAt`, or `error`, and SHALL NOT fire `session:activity`.

#### Scenario: Done is idle plus a completed turn
- **WHEN** a session's status becomes `idle` after a turn whose last record is a normal turn end
- **THEN** `activity.lastTurn` is `completed` and `activity.tool` is absent

#### Scenario: Bound at the prompt with no turns
- **WHEN** a session binds and its transcript has no finished turn
- **THEN** `activity.lastTurn` is absent, so consumers can tell "idle, never ran" from "done"

#### Scenario: Error stands through idle
- **WHEN** a turn ends with an API error and status then becomes `idle`
- **THEN** `activity.lastTurn` is `failed` and `activity.error` is set until the next user turn starts, when both clear

#### Scenario: Tool in progress
- **WHEN** a tool call has started and no result for it has been recorded
- **THEN** `activity.tool` names it, and it clears when its result is recorded

#### Scenario: Activity never overrides status
- **WHEN** the transcript shows an unfinished tool call but the harness reports `idle`
- **THEN** `status` is `idle`, and `activity.tool` is cleared with `lastTurn` set to `interrupted`

#### Scenario: One turn ended several times
- **WHEN** a finished turn is recorded as several turn ends (a reply split into records that each end the turn, then a turn-duration record, then the session going idle)
- **THEN** `session:activity` fires once for the end, and `lastTurn` and `lastTurnEndedAt` come from the first end

#### Scenario: A new turn can end again
- **WHEN** a turn has ended and a new turn or tool call then starts and ends
- **THEN** that later end updates `lastTurn` and `lastTurnEndedAt` and fires `session:activity`

### Requirement: Subagents
A session SHALL expose the subagents it launched as `Subagent` objects, each with:
- `id`
- `sessionId` (the root session)
- `parentId` (the launching subagent's id, or absent when launched by the root)
- `harness`
- `type` (e.g. `Explore`)
- `title`
- `background` (boolean)
- `status`: `running`, `completed`, `failed`, or `cancelled`
- `startedAt`, and `endedAt` once no longer running

Each subagent SHALL have its own `transcript()` and `events()`. A subagent's records SHALL NOT change the root session's `activity.tool`, `lastTurn`, or `error`.

#### Scenario: Subagent launched
- **WHEN** a live session launches a subagent
- **THEN** `subagent:start` fires with the `Subagent` and the root `Session`, and `activity.openSubagents` increments

#### Scenario: Subagent completes
- **WHEN** the harness records that subagent's result
- **THEN** `subagent:end` fires with `status` `completed` or `failed` and `endedAt` set, and `openSubagents` decrements

#### Scenario: Nested subagent
- **WHEN** a subagent launches its own subagent
- **THEN** the nested subagent has `parentId` set to the launching subagent's id and the same `sessionId`

#### Scenario: Background subagent outlives the turn
- **WHEN** a background subagent is still running and the root session becomes `idle`
- **THEN** the subagent stays `running` until its completion is recorded

#### Scenario: Foreground subagent cut off
- **WHEN** a foreground subagent has no recorded result and the root session becomes `idle`
- **THEN** `subagent:end` fires with `status` `cancelled`

#### Scenario: Session closes with subagents open
- **WHEN** a session closes while subagents are `running`
- **THEN** each gets `subagent:end` with `status` `cancelled` before `session:close`

### Requirement: Subagent queries and catch-up
`session.subagents()` SHALL return that session's subagents, live or historical, in launch order. During `start()` catch-up, the system SHALL emit `subagent:start` for every still-running subagent of each live session, with `catchUp: true`, after that session's create/open and before `ready`. For a subagent, `get(id)` SHALL return undefined, since `get` is for sessions only.

#### Scenario: History of a closed session
- **WHEN** `subagents()` is called on a closed session that ran three subagents
- **THEN** all three are returned with final statuses and none is `running`

#### Scenario: Catch-up of a running subagent
- **WHEN** `start()` is called while a live session has one running background subagent
- **THEN** `subagent:start` is emitted for it with `catchUp: true` before `ready`

### Requirement: Live query
`running()` SHALL return the in-memory live set synchronously, without disk I/O. Before `start()` and after `stop()` it SHALL return an empty array.

#### Scenario: Running reflects events
- **WHEN** `session:close` has been emitted for an id
- **THEN** `running()` no longer contains that id

### Requirement: Historical query
`sessions(filter?)` SHALL return live and closed root sessions from all providers, merged by id so that a live session appears once with its `pid`. Subagents SHALL NOT be returned as sessions. The filter SHALL support `harness`, `cwd`, `live`, `kind`, and `since` (epoch ms, matched against `updatedAt`, falling back to `startedAt`). `sessions()` SHALL work without `start()`.

#### Scenario: Sessions from today
- **WHEN** `sessions({ since: startOfToday })` is called
- **THEN** only sessions whose `updatedAt` (or, if missing, `startedAt`) is at or after that time are returned

#### Scenario: Live filter
- **WHEN** `sessions({ live: true })` is called after `start()`
- **THEN** the result equals the ids in `running()`

### Requirement: Lookup by id
`get(id)` SHALL return the session with that harness session id from any provider, live or not, or `undefined`.

#### Scenario: Unknown id
- **WHEN** `get` is called with an id no provider knows
- **THEN** it resolves to `undefined`

### Requirement: Transcript replay and tail
`session.transcript()` SHALL yield the stored conversation as normalized `Turn` objects (see harness-providers) and then finish. `session.events()` SHALL yield the stored records and then keep yielding appended records until the consumer stops, at which point its watch SHALL be released. The consumer stops either by ending iteration (`break`, or the iterator's `return()`) or by calling `close()` on the value `events()` returned. Both SHALL work while the consumer is waiting for the next record, not only between records: the pending `next()` SHALL resolve as done. Neither `transcript()` nor `events()` SHALL poll. Each normalized item SHALL keep the provider's original record on `raw`.

#### Scenario: Tail sees appends
- **WHEN** a consumer iterates `events()` and the harness appends a user message
- **THEN** a `user` item with that text is yielded without a timer-driven re-read

#### Scenario: Break releases the watch
- **WHEN** the consumer breaks out of `for await` over `events()`
- **THEN** the underlying file watch is closed

#### Scenario: Close while waiting
- **WHEN** a consumer has read every stored record, is awaiting the next one, and `close()` is called
- **THEN** the pending `next()` resolves as done and the underlying file watch is closed

#### Scenario: Partial line at end of file
- **WHEN** the harness has written half of a JSON line
- **THEN** nothing is yielded for it until the line is complete

### Requirement: Harness neutrality of the core
The core API and its implementation SHALL NOT reference any specific harness's paths, record formats, or status words. All such knowledge SHALL live in providers.

#### Scenario: Core without built-ins
- **WHEN** an instance is created with only a custom in-memory provider
- **THEN** every requirement above holds and no Claude Code path is touched

### Requirement: Injected environment
The instance SHALL accept an `fs` implementation and a `processes` implementation and pass them to every provider through its context. The defaults are the local filesystem and local process facilities. Every requirement in this change SHALL hold against a supplied implementation that delivers notifications, so a consumer can observe agents on a remote machine through its own transport.

#### Scenario: Remote filesystem
- **WHEN** an instance is created with an `fs` that brokers to another machine and forwards its change notifications
- **THEN** that machine's sessions are emitted and no local path is read

### Requirement: Provider failure isolation
A provider that throws or rejects SHALL NOT stop other providers or crash the process. This covers `watch`, `list`, `inspect`, `revalidate`, and any failure the provider reports after `watch` has returned. The error SHALL be emitted as an `error` event with payload `{ source: 'provider', provider, error }`, naming the provider id.

#### Scenario: One provider throws during watch
- **WHEN** one of two providers throws in `watch`
- **THEN** `error` is emitted for it, and the other provider's sessions still produce events and `ready` still fires

#### Scenario: Provider reports a failure while running
- **WHEN** a provider reports a failure after its `watch` has returned
- **THEN** `error` is emitted with `source` `provider` and that provider's id, and the provider's other sessions keep producing events

### Requirement: Listener failure isolation
A listener that throws SHALL NOT affect the provider whose fact caused the event, the other listeners of that event, or any later event. The failure SHALL be emitted as an `error` event with payload `{ source: 'listener', event, error }`, where `event` is the name of the event the listener was handling. A listener failure SHALL never be lost silently: if no `error` listener is registered, or if an `error` listener itself throws, the error SHALL be rethrown asynchronously so that it surfaces as an uncaught exception instead of unwinding into the core or a provider.

#### Scenario: Throwing listener does not stop updates
- **WHEN** a `session:activity` listener throws while an `error` listener is registered
- **THEN** `error` is emitted with `source` `listener` and `event` `session:activity`, the other `session:activity` listeners still run, and later changes to that session still produce events

#### Scenario: No error listener
- **WHEN** a listener throws and no `error` listener is registered
- **THEN** the error surfaces as an uncaught exception after the current event has been delivered to every listener, and the instance keeps running

### Requirement: History is read through the owning provider
`transcript()`, `events()`, and `subagents()` of a session or subagent SHALL be served by the provider named in that session's `provider` field, however the session was obtained. The core SHALL NOT fall back to another provider. When no configured provider has that id, or it implements no history, they SHALL yield nothing.

#### Scenario: Second provider's history
- **WHEN** two providers are configured and a closed session listed by the second one has its `transcript()` iterated
- **THEN** the second provider is asked for it and the first is not

#### Scenario: Provider without history
- **WHEN** `transcript()` is iterated for a session whose provider implements only `watch`
- **THEN** it yields nothing and no other provider is asked

### Requirement: Bounded memory for closed sessions
The instance SHALL keep what it learned about a closed session (its last known fields, titles, and subagents) so that `get()` and `sessions()` still return it, but SHALL bound that memory: it SHALL retain at least the 1000 most recently closed sessions and SHALL release older ones. A released session SHALL still be returned when its provider lists it.

#### Scenario: Long-running instance
- **WHEN** 1001 sessions have closed during one run
- **THEN** the instance holds in-memory state for 1000 closed sessions, and the oldest is returned by `get()` only if its provider's `list` yields it
