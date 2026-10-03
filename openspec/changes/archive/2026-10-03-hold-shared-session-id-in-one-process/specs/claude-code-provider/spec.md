## ADDED Requirements

### Requirement: One session id held by several processes
When several live processes have session files naming the same session id, the provider SHALL bind exactly one of them, the holder, and the session SHALL report the holder's `pid`, status and journal. The holder SHALL be the process with the latest `startedAt`. When `startedAt` is missing or equal, the process whose file was seen last SHALL hold the id, and a file already waiting SHALL keep waiting.

A process that takes an id from a holder SHALL cause `session:close` for that id, followed by `session:create` or `session:open` with its own `pid`. The other processes SHALL wait: no session event SHALL be emitted from their files while the holder lives, including when they rewrite them.

When the holder exits, removes its file, or switches to another session id, the provider SHALL service the waiting files for that id again, so the session reopens under a waiting process that is still alive. A waiting file that is removed, unreadable, or fails validation SHALL be forgotten.

#### Scenario: Resumed in a second terminal
- **WHEN** a session is live under process A, and process B, started later, writes a session file naming the same session id
- **THEN** `session:close` is emitted, then `session:create` or `session:open` with B's `pid`, and the session reports B's status

#### Scenario: First process exits after the resume
- **WHEN** B holds a session id that A also names, and A exits
- **THEN** no session event is emitted, and `running()` still lists the session with B's `pid`

#### Scenario: Holder exits while another process waits
- **WHEN** B holds a session id that A also names, and B exits while A is alive
- **THEN** `session:close` is emitted, then `session:create` or `session:open` with A's `pid`

#### Scenario: Both present at start
- **WHEN** the provider starts with session files from A and B naming the same session id, B having started later
- **THEN** exactly one session is live for that id, with B's `pid`

#### Scenario: Waiting process rewrites its file
- **WHEN** A waits on a session id B holds, and A's session file is rewritten with a new status
- **THEN** no session event is emitted and the session keeps B's `pid` and status
