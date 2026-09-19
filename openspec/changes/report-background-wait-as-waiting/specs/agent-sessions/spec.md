## ADDED Requirements

### Requirement: Waiting on background work
`waiting` SHALL cover two cases: the session is blocked on the user, or its turn is over while background work that the harness will wake it for is still running. In the second case `waitingFor` SHALL be `shell` for a background shell command and `monitor` for a background monitor, and these two values SHALL NOT be used for a wait on the user. A session in a background wait SHALL NOT be reported `idle` until that work has ended. A running background subagent SHALL NOT by itself make its session `waiting`; it is reported on the subagent surface. A provider whose harness records no such work SHALL report `idle`.

The turn that started the background work SHALL still end when the harness ends it, so `activity.lastTurn` is set while `status` is `waiting`.

#### Scenario: Turn over, background shell running
- **WHEN** a session's turn ends while a background shell command it started is still running
- **THEN** `status` is `waiting`, `waitingFor` is `shell`, and `activity.lastTurn` is `completed`

#### Scenario: Woken by the background work
- **WHEN** the background work reports and the harness starts a new turn
- **THEN** `status` becomes `running` and `waitingFor` is absent

#### Scenario: Background work ends without a wake
- **WHEN** the last running background job ends and no turn is open
- **THEN** `status` becomes `idle`

#### Scenario: Background subagent only
- **WHEN** a turn ends with a background subagent still running and no background shell or monitor
- **THEN** `status` is `idle` and the subagent stays `running`

#### Scenario: Telling the two waits apart
- **WHEN** a consumer sees `status` `waiting`
- **THEN** `waitingFor` of `shell` or `monitor` means nothing is asked of the user, and any other value or none means the user is
