## ADDED Requirements

### Requirement: Background bash jobs
The provider SHALL track background bash jobs from the root transcript. A `toolResult` whose `details.async` has `state` `running`, `type` `bash` and a `jobId` SHALL open that job. A job SHALL close when an `async-result` `custom_message` names its `jobId` in `details.jobs[]`, when a `toolResult` names it in `details.jobs[]` with a final status, or on `session_exit`. While no turn is open and at least one job is open, `status` SHALL be `waiting` with `waitingFor` `shell` instead of `idle`. An open turn SHALL keep its own status. Jobs of `type` `task` are subagents and SHALL NOT affect `status`. Jobs SHALL be rebuilt by the bind replay without emitting intermediate statuses, and a job left open by an earlier process SHALL be dropped at bind.

#### Scenario: Backgrounded bash outlives the turn
- **WHEN** a `bash` result carries `details.async` `{ state: running, jobId: bg_1, type: bash }` and the assistant then stops
- **THEN** `status` is `waiting` and `waitingFor` is `shell`

#### Scenario: Result delivered
- **WHEN** an `async-result` message naming `bg_1` is appended and the assistant replies
- **THEN** `status` is `running` while the turn is open and `idle` once it ends with no job open

#### Scenario: Collected through hub
- **WHEN** a `hub` result lists `bg_1` in `details.jobs[]` as `completed`
- **THEN** the job is closed and the next turn end gives `idle`

#### Scenario: Two jobs, one reports
- **WHEN** `bg_1` and `bg_2` are open, the turn is over, and an `async-result` names only `bg_1` and its turn ends
- **THEN** `status` is `waiting` with `waitingFor` `shell`

#### Scenario: Background task agent only
- **WHEN** a `task` result carries `details.async` with `type` `task` and the turn ends
- **THEN** `status` is `idle` and the subagent stays `running`

#### Scenario: Job from a dead process
- **WHEN** a session binds to a transcript whose open job was started before the bound process started
- **THEN** `status` is `idle`
