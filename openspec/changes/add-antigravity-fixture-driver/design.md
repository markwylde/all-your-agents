## Context

`antigravityCli` binds a root conversation to the one live process holding `presence/<uuid>.lock` (the `processes.holders` probe), then reads its summary row and conversation steps through SQLite. Other drivers only write files and take a `pid`; for AntiGravity a pid alone is not enough under the real probe, because that process must hold the lock open.

## Decisions

- **Real SQLite files.** The driver writes the same tables and protobuf step payloads as agy 1.5.5 through `node:sqlite`, opening and closing a connection per step in rollback-journal mode. Conversation databases are updated in place, never replaced, so the provider's inode check keeps the binding.
- **Two holder modes.** `driver.processes` fakes the probe for unit tests. For the real probe, `spawnHolder(id)` passes the open lock as an inherited file descriptor to `sleep`, and `prepareLock(id)` lets a caller's own process (for example one in a terminal) open it. `createLiveSession` touches the lock afterwards so the provider looks again.
- **`switchConversation`** moves a fake holder only; a real process cannot be made to reopen a different lock, so callers spawn a new holder instead.
- **`remove`** deletes the lock and stops a spawned holder. Running children are marked killed, as agy does.
- **Lazy `node:sqlite`.** Loaded on first write, so importing the testing entry never requires it.

## Risks

- The step encoding follows the provider's decoder rather than captured agy output; the provider's own tests remain the source of truth for the format.
