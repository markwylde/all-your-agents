## MODIFIED Requirements

### Requirement: Catch-up after watch churn
The file interface MAY implement `onWatchChurn(listener)`, returning an unsubscribe function. An implementation whose watches can drop events while another watch is being opened or closed SHALL implement it and SHALL call every listener after each watch it opens or closes. The default local filesystem SHALL implement it on macOS, for every watch opened through it anywhere in the process, and SHALL NOT implement it where the platform does not have the defect.

While it is open, every shared watch helper SHALL subscribe when the file interface offers `onWatchChurn`, and SHALL unsubscribe when it closes. After churn a helper SHALL re-verify what it covers and service only what differs from what it last serviced:
- `watchDir`: entries that appeared are reported as created, entries that are gone as deleted, and an entry whose size or modification time changed as changed. While waiting for a missing directory it SHALL check for that directory.
- `watchFile`: a change is reported when the file's existence, size, or modification time differs.
- `tailJsonl`: bytes appended since the last read are read and their records yielded.

The re-verification SHALL go through the helper's debounce, so a burst of opens and closes causes one pass, and the pass happens after the churn rather than during it. Because a rebuild can outlast the debounce on a loaded machine, the helper SHALL make one more pass the latency ceiling (`maxLatencyMs`) after the first churn of a burst, so a burst causes at most two passes. Both SHALL be caused only by churn, never by a clock: a timer exists only between a churn and the last pass it causes, and once that pass has run no timer remains. An entry that did not change SHALL NOT be reported and SHALL NOT be read. A helper's own open counts as churn.

#### Scenario: Status rewrite lost while another session binds
- **WHEN** a session file is rewritten, its notification is never delivered, and another watch is opened at that moment
- **THEN** `watchDir` reports one change for that session file within the debounce window, and reports nothing for the other entries

#### Scenario: Journal append lost
- **WHEN** records are appended to a tailed journal, the notification is never delivered, and churn follows
- **THEN** the appended records are yielded once

#### Scenario: Entry created or removed unseen
- **WHEN** an entry is created and another removed without notifications, and churn follows
- **THEN** one create and one delete are reported

#### Scenario: Burst of opens
- **WHEN** ten watches open within a few milliseconds
- **THEN** each open helper re-verifies once after the debounce and once more at the latency ceiling, and no more

#### Scenario: Rebuild slower than the debounce
- **WHEN** a file is rewritten after the first pass has run but before the watch stream has been rebuilt, and its notification is never delivered
- **THEN** the second pass reports the change

#### Scenario: Nothing changed
- **WHEN** churn happens and nothing a helper covers has changed
- **THEN** it reports nothing, and no timer remains once the second pass has run

#### Scenario: Closed helper
- **WHEN** a helper is closed and churn follows
- **THEN** it is no longer subscribed and does nothing

#### Scenario: Established watch under churn on macOS
- **WHEN** 200 files are created in a directory watched by `watchDir` while other watches open and close around every write
- **THEN** all 200 creates are reported

#### Scenario: Filesystem without the defect
- **WHEN** the file interface does not implement `onWatchChurn`
- **THEN** the helpers behave exactly as without this requirement
