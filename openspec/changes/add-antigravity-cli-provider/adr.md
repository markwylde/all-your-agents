# ADR: Observe agy local SQLite and held presence locks

Status: accepted for this change.

Use read-only injected SQLite and OS notifications, consistent with ADR 0001. Held presence locks identify a CLI conversation owner more accurately than timestamps or backend database handles. Support the current SQLite schema, including generation/executor metadata, requested interactions and child trajectories. Recover legacy text from generated logs when available; opaque protobuf files without logs remain unavailable. This avoids auth/IPC coupling and new dependencies.

## Registry evidence (agy 1.5.5, macOS, 2026-11-10)

The home listing includes `presence/`, `conversations/` and `conversation_summaries.db`; there is no PID JSON registry. Before the probe there were nine stale UUID `.lock` entries and no regular-file holders. An interactive run with a read-only one-line prompt created `presence/c0ed61d4-a0ee-4e3d-9e4f-f6c116ef40b5.lock` and its SQLite conversation. `lsof` showed the agy CLI PID holding that lock as a writable regular file (the language-server backend was not its holder). `/exit` released the handle but retained the zero-byte lock. Resuming that UUID before any new prompt reacquired the lock, updating its mtime. This registry provides the discovery event and a one-shot holders probe supplies the PID.

The existing Processes interface proves an open descriptor, not advisory-lock ownership or executable identity. Accept exactly one live non-observer holder; ambiguous holders bind nothing. An unrelated process deliberately opening this registry path is indistinguishable with the current interface; document this trust boundary rather than claiming stronger validation.
