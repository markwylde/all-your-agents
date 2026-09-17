## MODIFIED Requirements

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
