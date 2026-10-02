## 1. Queued task notifications

- [x] 1.1 `taskNotificationText`: return the notification text of a user record or of a `queued_command` attachment marked as a task notification; verify a queued user prompt and other attachments return nothing
- [x] 1.2 `handleRecord`: end the matching running subagent from either form; verify a queued notification ends its background agent, `killed` maps to `cancelled`, a background shell's notification ends nothing, and a repeat as a user record does not end it twice

## 2. Verification

- [x] 2.1 `npm run lint` and `npm test` pass
