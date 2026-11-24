## Why

The testing kit has a fixture driver for every built-in provider except `antigravity-cli`. Consumers that test their own agent views, such as Terminay's Agents pane end-to-end tests, cannot make an AntiGravity session look live without the real `agy` binary.

## What Changes

- Add `createAntigravityFixtureDriver(home, { settleMs })` to `@markwylde/all-your-agents/testing`. It writes agy 1.5.5's `conversation_summaries.db`, `conversations/<uuid>.db` steps and `presence/<uuid>.lock` with Node's built-in SQLite, and implements every `FixtureDriver` step, including the background wait.
- The driver exposes fake `processes` whose holder probe reports each `createLiveSession` pid as the lock's holder, for unit tests.
- For the real process probe, `spawnHolder(id)` starts a real process holding the lock open, and `prepareLock(id)` creates the lock for a process the caller starts. `dispose()` stops spawned holders. Calling `createLiveSession` again with a new pid resumes a stored conversation.
- The provider's test fixtures reuse the driver's protobuf step encoder instead of keeping their own copy.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `harness-providers`: the conformance kit has an AntiGravity fixture driver.

## Impact

New `src/testing/antigravity-driver.ts`, testing export, tests and README. No runtime dependency. The driver needs Node ≥ 22.13 for `node:sqlite`; the testing entry still loads without it.
