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

#### Scenario: oh-my-pi provider passes
- **WHEN** the conformance kit runs against the oh-my-pi provider with its fixture driver
- **THEN** every conformance case passes

#### Scenario: In-memory provider passes
- **WHEN** the conformance kit runs against a minimal in-memory test provider
- **THEN** every conformance case passes, proving the kit has no harness assumptions

## ADDED Requirements

### Requirement: Controlling-terminal probe
The `Processes` interface MAY implement `tty(pid)`, a one-time probe that returns the name of the process's controlling terminal as the device path below `/dev` (for example `ttys024` or `pts/3`), or nothing when the process has no controlling terminal or does not exist. A provider whose harness records the terminal a session runs in SHALL use it to join a live pid to that record. A missing implementation SHALL NOT be treated as an error: that provider emits no live sessions that depend on it and still serves history. The probe SHALL be called only in response to start, a filesystem notification, or `reconcile`; it SHALL NOT run on a timer. The default local `Processes` SHALL implement it on macOS and Linux.

#### Scenario: Process on a terminal
- **WHEN** `tty(pid)` is called for a process started in a terminal
- **THEN** that terminal's name is returned once, and no timer is armed

#### Scenario: Process with no terminal
- **WHEN** `tty(pid)` is called for a process whose stdin is a pipe and that has no controlling terminal
- **THEN** nothing is returned

#### Scenario: Probe absent
- **WHEN** a custom `Processes` implements only `info` and `watch`
- **THEN** providers that need `tty` emit no live sessions from it and do not throw

### Requirement: Injected SQLite reader
The `WatchContext`, `ListContext` and `InspectContext` MAY carry `sqlite`, a read-only reader that opens a database file by path and runs a parameterised query, returning rows. It SHALL be the only way a provider reads a SQLite file: a provider SHALL NOT import a SQLite library or `node:sqlite` directly. A consumer MAY supply its own reader through the instance options (for example one that queries a remote machine), or pass `sqlite: false` to have none. The default SHALL use the runtime's built-in SQLite when the running Node provides it and SHALL be absent otherwise; the package SHALL NOT gain a runtime dependency for it. The reader SHALL open databases read-only, SHALL NOT leave a transaction or connection open between calls, and SHALL work while another process is writing the database in WAL mode. A provider SHALL treat a missing reader as "that source is unavailable", not as an error. A query SHALL run only in response to start, a filesystem notification, `reconcile`, or a consumer's `list` / `inspect` call.

#### Scenario: Writer active
- **WHEN** another process holds a WAL-mode database open and commits a row, and the reader then queries it
- **THEN** the committed row is returned and the writer is not blocked

#### Scenario: Runtime without SQLite
- **WHEN** the running Node has no built-in SQLite and the consumer supplies no reader
- **THEN** `sqlite` is absent from the contexts, nothing throws, and every provider keeps observing what it can from files

#### Scenario: Turned off
- **WHEN** an instance is created with `sqlite: false`
- **THEN** `sqlite` is absent from every context even though the runtime has SQLite

#### Scenario: Provider bypasses the reader
- **WHEN** a provider imports `node:sqlite`
- **THEN** the neutrality test fails

#### Scenario: Idle
- **WHEN** an instance has started and nothing changes
- **THEN** no query runs and no connection is open

### Requirement: watchFile reports held-open writes
`watchFile` SHALL accept a `heldOpen` option. With it, `watchFile` SHALL report a change when the file is written through a handle the writer keeps open, which a watch on the parent directory does not report on macOS. It SHALL still follow the path rather than the inode: when the file is removed or replaced, it SHALL keep delivering for the file now at that path. The same debounce, latency ceiling and watch-churn rules SHALL apply. Without the option `watchFile` SHALL behave exactly as before.

#### Scenario: WAL commit by a long-lived writer
- **WHEN** a process holds a SQLite WAL file open and commits five times, and that file is watched with `heldOpen`
- **THEN** a change is reported for the commits, coalesced by the debounce

#### Scenario: File replaced
- **WHEN** a file watched with `heldOpen` is deleted and created again, and the new file is then written through a held handle
- **THEN** a change is reported for that write

#### Scenario: Option off
- **WHEN** `watchFile` is called without `heldOpen`
- **THEN** only the parent directory is watched

### Requirement: File identity in stat
`FsStat` MAY carry `ino`, the file's inode where the filesystem has one. The default local filesystem SHALL supply it. A provider MAY use it to tell a file that was replaced (a rewrite renamed over the path) from one that was only appended to, which sizes and modification times cannot. A file interface that omits it SHALL remain valid: a provider SHALL then treat the file as not replaced.

#### Scenario: Replaced by rename
- **WHEN** a file is rewritten to a temporary sibling that is renamed over it
- **THEN** the local filesystem's `stat` reports a different `ino` for that path than before

#### Scenario: Interface without inodes
- **WHEN** a custom file interface returns no `ino`
- **THEN** providers keep working and never report a replacement from it
