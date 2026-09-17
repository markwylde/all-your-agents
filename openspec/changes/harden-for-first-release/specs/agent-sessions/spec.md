## MODIFIED Requirements

### Requirement: Instance lifecycle
The system SHALL create an instance from a list of providers and optional `{ fs, processes, debounce: { quietMs, maxLatencyMs } }` overrides. Nothing is watched until `start()` is called. `start()` and `stop()` SHALL each be idempotent. After `stop()` resolves, no further events SHALL be emitted and every watch, file and process, SHALL be released. `stop()` SHALL forget every session that was live, together with its titles and subagents, so that a later `start()` catches up exactly as a new instance would.

#### Scenario: Stop releases watches
- **WHEN** `stop()` resolves after a successful `start()`
- **THEN** no further events are emitted and every file and process watch is released

#### Scenario: Restart catches up again
- **WHEN** an instance is stopped while a live session has a running subagent, and `start()` is then called again
- **THEN** `session:open` or `session:create` and `subagent:start` are emitted for them with `catchUp: true` before `ready`

### Requirement: Session shape
Every emitted or returned session SHALL have `id`, `harness`, `provider`, and `activity`. It MAY have `pid`, `cwd`, `title`, `status`, `waitingFor`, `startedAt`, `updatedAt`, `kind` (`interactive` or `headless`), and `model` (the model that produced the most recent reply, as the harness names it). `status` SHALL be one of `running`, `waiting`, or `idle`, or be absent when the provider cannot tell. `waitingFor` SHALL be present only when `status` is `waiting`. `pid` SHALL be present only while a process holds the session. A field that is unknown SHALL be absent rather than present with an `undefined` value, whichever query or event returned the session.

#### Scenario: Unknown status omitted
- **WHEN** a provider cannot determine status
- **THEN** the session has no `status` field rather than a guessed value

#### Scenario: Same shape from every source
- **WHEN** the same live session is obtained from an event, from `running()`, from `sessions()`, and from `get(id)`
- **THEN** all four have the same own keys and values, and `activity` is a copy that later changes do not mutate

### Requirement: Provider failure isolation
A provider that throws or rejects SHALL NOT stop other providers or crash the process. This covers `watch`, `list`, `inspect`, `revalidate`, and any failure the provider reports after `watch` has returned. The error SHALL be emitted as an `error` event with payload `{ source: 'provider', provider, error }`, naming the provider id.

#### Scenario: One provider throws during watch
- **WHEN** one of two providers throws in `watch`
- **THEN** `error` is emitted for it, and the other provider's sessions still produce events and `ready` still fires

#### Scenario: Provider reports a failure while running
- **WHEN** a provider reports a failure after its `watch` has returned
- **THEN** `error` is emitted with `source` `provider` and that provider's id, and the provider's other sessions keep producing events

## ADDED Requirements

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
