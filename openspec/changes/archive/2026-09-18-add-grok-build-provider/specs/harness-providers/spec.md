## ADDED Requirements

### Requirement: watchFile follows the path, not the inode
`watchFile` SHALL watch the parent directory and filter events by the target filename. It SHALL NOT attach the kernel watch to the file inode. That way a tmp-then-rename rewrite (the writer creates a sibling and renames it over the target) keeps delivering: inotify follows the inode, so a watch on the file itself goes silent after the first replace, while a directory watch follows the path. The filename filter means sibling writes in the parent are ignored. When the parent does not exist, `watchFile` SHALL fall back the same way `watchDir` does for a missing directory (nearest existing ancestor, re-arm one level at a time).

#### Scenario: Atomic rewrite keeps delivering
- **WHEN** a watched file is replaced by writing a temporary sibling and renaming it over the original, and that happens twice
- **THEN** a change is reported for each rewrite, including the second

#### Scenario: Sibling ignored
- **WHEN** another file in the parent directory is written
- **THEN** no change is reported for the watched file

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

#### Scenario: In-memory provider passes
- **WHEN** the conformance kit runs against a minimal in-memory test provider
- **THEN** every conformance case passes, proving the kit has no harness assumptions
