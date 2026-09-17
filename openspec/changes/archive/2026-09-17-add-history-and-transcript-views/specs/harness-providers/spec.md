## ADDED Requirements

### Requirement: Inspect stops on request
When the core asks a provider to follow a session (`inspect` with `follow`), the `InspectContext` SHALL carry an `AbortSignal`. When it aborts, the provider SHALL stop following: release every watch it opened for that call and finish the iteration, even if it is waiting for the next record at that moment. A provider whose `inspect` does not follow MAY ignore the signal.

#### Scenario: Abort while idle
- **WHEN** a provider is following a journal that is not changing and the signal aborts
- **THEN** the iteration finishes and the journal is no longer watched
