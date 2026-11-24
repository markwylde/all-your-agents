## ADDED Requirements

### Requirement: AntiGravity fixture driver
The testing entry SHALL export `createAntigravityFixtureDriver(home, options)`, a fixture driver that writes AntiGravity CLI conversation summaries, conversation steps and presence locks in `home`. It SHALL expose fake `processes` that report each live session's pid as its lock holder, and SHALL be able to start a real process holding a conversation's lock open so the real process probe binds the session.

#### Scenario: AntiGravity provider passes
- **WHEN** the conformance kit runs against the AntiGravity CLI provider with its fixture driver and that driver's `processes`
- **THEN** every conformance case passes

#### Scenario: Real holder binds and releases the session
- **WHEN** a holder started by the driver holds a conversation's lock and `createLiveSession` is called with its pid and a cwd
- **THEN** the provider reports the session live with that pid and cwd, and closes it, keeping it in history, once the holder exits
