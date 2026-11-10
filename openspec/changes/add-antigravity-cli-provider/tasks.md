# Tasks

## 1. Persisted data

- [x] 1.1 Implement validated summary parsing, home/path resolution and history listing; test root filtering, id/since, malformed inputs and missing SQLite.
- [x] 1.2 Implement bounded protobuf step decoding and normalized text/tool/turn events with synthetic fixtures; test truncation, unknown formats, terminal reasons and mutable completion.

## 2. Live observation

- [x] 2.1 Implement held presence-lock discovery, process validation, close/reopen and reconcile; test stale locks, process exit, child exclusion and create versus open.
- [x] 2.2 Follow database/WAL writes using shared helpers with serialized work, error reporting and stop/abort cleanup; test updates, unchanged-row dedupe and pending iterator abort.

## 3. Integration

- [x] 3.1 Export/register the provider, extend public API tests and document supported agy version and partial compatibility; verify build and documented API.
- [x] 3.2 Run npm test, npm run lint and openspec validate --all; fix regressions and verify spec scenarios against implementation.
- [x] 3.3 Add deterministic end-to-end SQLite/lock coverage and run npm run test:e2e in Docker; record results. Screenshots are unnecessary for this nonvisual change.

## Additional review acceptance checks

- [x] 4.1 Cover missing probes, unsupported process watches, late storage, watch-before-scan and targeted reconcile using provider integration tests.
- [x] 4.2 Cover pending-row order, unknown/repaired payloads, terminal edits, database replacement and per-binding cancellation during reads; verify no events or watches survive stop.
- [x] 4.3 Cover bind-time activity replay, title precedence, UTC timestamps, stale waiting override and tool failure without turn failure; run the SQLite/WAL integration test on macOS as well as in Docker.
