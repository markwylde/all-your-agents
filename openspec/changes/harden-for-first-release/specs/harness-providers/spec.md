## MODIFIED Requirements

### Requirement: Shared watch helpers
The package SHALL provide helpers that providers use instead of writing their own watchers.
- `watchDir(path, onChange, { quietMs, maxLatencyMs })`: performs an initial scan, reports create/change/delete per entry, decides create/delete by existence after the burst rather than by event type, and coalesces bursts per entry.
- `watchFile(path, onChange, { quietMs, maxLatencyMs })`
- `tailJsonl(path, { backlog? })`: yields complete JSON lines from a byte offset, then appended lines, reading only on notification.
- `processInfo(pid)`: one-time `{ alive, startTime? }` probe.
- `watchProcess(pid, onExit)`: process exit notification, or `unsupported`.

When a watched directory does not exist, `watchDir` SHALL watch the nearest existing ancestor and begin watching once the directory appears, re-arming one level at a time. `watchDir` SHALL open its watch before it performs the initial scan, so an entry created while the scan runs is reported, and SHALL report each entry's creation once. When the watched directory is removed, `watchDir` SHALL report a delete for every entry it knew and re-arm as for a missing directory.

`tailJsonl` SHALL read each byte of the file once. With `backlog: 'separate'`, the complete records present when the tail opens SHALL be delivered together through the handle's `backlog` promise and SHALL NOT be yielded by iteration, which then yields only later appends; this lets a caller tell stored records from live ones without reading the file twice. `tailJsonl` SHALL decode UTF-8 across read boundaries, so a multi-byte character split between two reads is yielded intact.

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

#### Scenario: Character split across reads
- **WHEN** a line containing a multi-byte character is written in two parts that split that character, with a read between them
- **THEN** the record is yielded once, complete, with the character intact

## ADDED Requirements

### Requirement: Asynchronous failure reporting
The `WatchContext` SHALL expose `reportError(error)`. A provider SHALL use it for any failure that happens after `watch` has returned (for example while handling a tailed record) instead of throwing into a callback or discarding the error. The core SHALL emit each report as an `error` event naming that provider. A provider SHALL keep observing after it reports: one record that cannot be handled SHALL NOT end the tail it came from.

#### Scenario: Bad record does not end the tail
- **WHEN** handling one tailed record fails and further records are then appended
- **THEN** one `error` is emitted naming the provider, and the later records still produce their events
