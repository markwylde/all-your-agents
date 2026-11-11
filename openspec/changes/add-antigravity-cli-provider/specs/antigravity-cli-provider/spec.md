# AntiGravity CLI provider

## Purpose

Expose local AntiGravity CLI SQLite conversations through the harness-neutral session API using persisted facts and event-driven observation.

## ADDED Requirements

### Requirement: Built-in provider with configurable home
The package SHALL export `antigravityCli({ home? })`, id `antigravity-cli`, harness `AntiGravity`, and include it in builtInProviders. The default home SHALL be `~/.gemini/antigravity-cli`. All reads SHALL use injected filesystem, SQLite and process interfaces. Missing SQLite support or absent storage SHALL yield no sessions without failing other providers.

#### Scenario: Custom or absent storage
- **WHEN** the provider is configured with a temporary home, or no SQLite reader is available
- **THEN** it reads only that home, or yields nothing respectively

### Requirement: Validated live root conversations
Only a valid UUID conversation with no parent and a currently held matching presence lock SHALL be live. The holder MUST be alive. A stale lock SHALL NOT prove liveness. Process exit, lock deletion, loss of ownership on reconcile and conversation deletion SHALL close the binding. Existing conversations SHALL open; newly discovered conversations SHALL create. Rebinding SHALL reset per-binding state.

#### Scenario: Catch-up and stale locks
- **WHEN** two existing roots have locks but only one lock has a live holder
- **THEN** only that conversation opens during catch-up

#### Scenario: New conversation and resume
- **WHEN** a new SQLite root and held lock appear, then the holder exits and another process resumes it
- **THEN** create, close and open occur in order

#### Scenario: Parent or invalid identifier
- **WHEN** a child conversation or path-traversal identifier is encountered
- **THEN** no root session is emitted and no path outside the home is read

### Requirement: Summary history and metadata
History SHALL list valid root summary rows backed by SQLite or generated legacy transcripts, with title, local file workspace cwd and updatedAt when available. It SHALL honor id and since filters. Child rows SHALL be exposed as subagents; bounded generated legacy transcript logs SHALL also be supported when available. Unknown optional fields SHALL remain unset.

#### Scenario: Filtered history
- **WHEN** history is requested with an id and since boundary
- **THEN** only matching supported roots at or after the boundary are returned

### Requirement: Persisted status and conversation events
Known summary run states SHALL map to idle or running; a current step explicitly waiting SHALL map to waiting. Unknown states SHALL omit status. Supported user, assistant and tool records SHALL produce normalized events retaining raw rows. The provider SHALL emit turn-end only for a persisted terminal response or explicit failure or cancellation. Unsupported records SHALL NOT invent text, model names, subagents or completed turns.

#### Scenario: Normal transcript
- **WHEN** a user step is followed by a terminal assistant response
- **THEN** transcript exposes their text in one completed turn

#### Scenario: Unknown or malformed step
- **WHEN** a step contains truncated protobuf, an unsupported format or an unknown state
- **THEN** it produces no guessed conversation event and observation continues

### Requirement: Event-driven following and cleanup
Observation SHALL use shared directory and file watches, including held database WAL files, and process notifications without polling. Inspect follow SHALL detect appended or finalized mutable steps without replaying unchanged events. Abort and stop SHALL release all watches and finish pending iteration. Read failures after startup SHALL be reported without ending observation.

#### Scenario: WAL update and abort
- **WHEN** a live step completes through a WAL write and a transcript follower is later aborted while idle
- **THEN** the completion is observed once and all follower watches close

### Requirement: Full persisted lifecycle
The provider SHALL expose human model names from generation metadata, structured waiting reasons, tool starts before completion, executor failures and nested/background subagents. Pending background tools SHALL NOT block later events. Child transcripts SHALL be accessible only through a validated root relationship.

#### Scenario: Approval followed by background completion
- **WHEN** a tool waits for approval, begins running in the background and finishes after later steps
- **THEN** waitingFor identifies approval, the tool starts once, later steps are visible and the result appears once

#### Scenario: Nested child
- **WHEN** a root has a child with its own child and persisted terminal outcomes
- **THEN** subagents retain root and parent identities, background flags, terminal statuses and accessible transcripts
