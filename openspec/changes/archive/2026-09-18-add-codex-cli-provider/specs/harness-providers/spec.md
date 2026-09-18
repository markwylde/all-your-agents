## ADDED Requirements

### Requirement: Open-file holders probe
The `Processes` interface MAY implement `holders(path)` and `heldUnder(directory)`, each a one-time probe of which pids currently have the named file (or files under the directory) open. A provider whose harness writes no pid index SHALL use these probes, when present, to bind live sessions. A missing implementation SHALL NOT be treated as an error: that provider emits no live sessions from open files and still serves history. The probe SHALL be called only in response to start, a filesystem notification, or `reconcile`; it SHALL NOT run on a timer. The default local `Processes` SHALL implement both (via `lsof` on macOS and `/proc/*/fd` on Linux).

#### Scenario: Held file at start
- **WHEN** `heldUnder(sessionsDir)` is called and a process has a rollout open
- **THEN** that path and pid are returned once, and no timer is armed

#### Scenario: Probe absent
- **WHEN** a custom `Processes` implements only `info` and `watch`
- **THEN** providers that need holders emit no live sessions from open files and do not throw

## MODIFIED Requirements

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

#### Scenario: Grok Build provider passes
- **WHEN** the conformance kit runs against the Grok Build provider with its fixture driver
- **THEN** every conformance case passes

#### Scenario: Codex CLI provider passes
- **WHEN** the conformance kit runs against the Codex CLI provider with its fixture driver
- **THEN** every conformance case passes

#### Scenario: In-memory provider passes
- **WHEN** the conformance kit runs against a minimal in-memory test provider
- **THEN** every conformance case passes, proving the kit has no harness assumptions
