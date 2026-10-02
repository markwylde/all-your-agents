## Why

A Claude Code background agent that finished while the root turn was still running never ended. Claude Code queues that task notification and records it as an `attachment` record (`attachment.type` `queued_command`, `commandMode` `task-notification`), not as a user record. The provider only read the user-record form, so no `subagent:end` was emitted and the subagent stayed `running` until the session closed.

A consumer that binds later does not see this, because subagents already in the journal at bind are reported as ended. A long-lived watcher does: it shows the agent as working indefinitely.

## What Changes

- **claude-code**: a task notification recorded as a `queued_command` attachment ends its background subagent, with the same status mapping as the user-record form. A notification recorded in both forms ends the subagent once.
- `attachment` records stay unmapped as session events; only the subagent lifecycle reads them.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `claude-code-provider`: background subagents end on either recorded form of a task notification.

## Impact

- Code: `src/providers/claude-code/{journal,provider}.ts`.
- Consumers see `subagent:end` for background agents that previously stayed `running`.
