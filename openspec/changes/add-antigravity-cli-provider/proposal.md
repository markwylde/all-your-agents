# Proposal

## Why

AntiGravity's `agy` CLI is missing from the built-in providers. Its local SQLite conversations and held presence locks allow it to join the existing event-driven session API without launching the CLI or using IPC.

## What Changes

- Add the `antigravity-cli` provider, harness `AntiGravity`, exported as `antigravityCli()` and included by default.
- Discover live root conversations through held `presence/<uuid>.lock` files and validate their processes; stale lock files are history only.
- Read current SQLite summaries and conversation steps through the injected SQLite reader for metadata, status, history and normalized conversation events.
- Follow database and WAL notifications with shared watch helpers, never polling.
- Document format and runtime limits. Legacy protobuf files, remote-only sessions, subagent tracking, numeric model-name resolution and background-work inference are outside this first version.

## Capabilities

### New Capabilities

- `antigravity-cli-provider`: Observe local agy SQLite conversations and expose their supported facts through the existing API.

### Modified Capabilities

None. The provider uses the existing extensible provider contract.

## Impact

New isolated provider modules, public export and built-in registration, tests and documentation. No new runtime dependencies. SQLite support requires Node >=22.13 or an injected reader; without one this provider contributes no sessions. This is not a visual change and PR screenshots are unnecessary.
