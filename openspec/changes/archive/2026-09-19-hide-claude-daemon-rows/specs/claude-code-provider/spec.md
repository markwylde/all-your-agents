## MODIFIED Requirements

### Requirement: Live index from session files
The provider SHALL treat `<home>/sessions/<pid>.json` as the only live index. It SHALL read only these fields:
- `pid`
- `sessionId`
- `cwd`
- `startedAt`
- `version`
- `status`
- `statusUpdatedAt`
- `waitingFor`
- `name`
- `updatedAt`
- `kind`
- `entrypoint`
- `spare`
- `jobId`
- `parkedJobId`

It SHALL NOT open `.key` siblings or the messaging socket. It SHALL NOT use journal mtime, "newest journal", or open file handles to decide which process holds which session. Processes with no session file, including background-daemon `bg-pty-host` wrappers and spares that have not written a file, SHALL NOT produce sessions.

#### Scenario: Key sibling ignored
- **WHEN** `<pid>.<digest>.key` exists beside `<pid>.json`
- **THEN** the provider never opens it

#### Scenario: Two sessions in one directory
- **WHEN** two live processes with the same cwd each have a session file naming different session ids
- **THEN** each process is bound to its own session id, whichever journal was written last

#### Scenario: Daemon wrapper without a session file
- **WHEN** a live `bg-pty-host` process has no `<pid>.json`
- **THEN** no session event is emitted for it

## ADDED Requirements

### Requirement: Unclaimed spares are not sessions
A session file that passes validation and has `"spare": true` SHALL NOT produce any session event. When that file is rewritten without `"spare": true`, the provider SHALL validate and bind it like a newly appeared file. When a bound file is rewritten with `"spare": true`, the provider SHALL emit `session:close` for the bound session.

#### Scenario: Pre-warmed spare
- **WHEN** a live process writes a session file with `"spare": true`, `"kind": "bg"` and a session id that has no journal
- **THEN** no `session:create`, `session:open`, `session:status` or title is emitted for it

#### Scenario: Spare is claimed
- **WHEN** a spare's session file is rewritten without `spare`, naming a session id
- **THEN** `session:create` or `session:open` is emitted for that session id

#### Scenario: Bound file becomes a spare
- **WHEN** a bound session file is rewritten with `"spare": true`
- **THEN** `session:close` is emitted for the bound session and nothing further until the file is rewritten without `spare`

### Requirement: Interactive sessions parked on a background job
When an accepted session file has a `parkedJobId`, and another accepted, non-spare session file of a live process has a `jobId` equal to it, the provider SHALL NOT expose the parked file's session. If the parked session was already bound, the provider SHALL emit `session:close` for it. When the job's session closes, or the parked file is rewritten without that `parkedJobId`, the provider SHALL bind the parked file again as a newly appeared file. A `parkedJobId` that matches no live job SHALL NOT hide the session.

#### Scenario: Terminal hands its work to a job
- **WHEN** an interactive session file has `"parkedJobId": "7a6f4abc"` and a live bg session file has `"jobId": "7a6f4abc"`
- **THEN** only the bg session is exposed

#### Scenario: Job seen after the parked terminal
- **WHEN** the interactive file is bound first and the matching job's file is accepted later
- **THEN** `session:close` is emitted for the interactive session

#### Scenario: Job ends
- **WHEN** the job's process exits or its file is removed while the parked interactive process is still live
- **THEN** the interactive session is bound again with `session:open` or `session:create`

#### Scenario: Orphaned parked id
- **WHEN** an interactive file has a `parkedJobId` that no live session file's `jobId` matches
- **THEN** the interactive session is exposed as usual
