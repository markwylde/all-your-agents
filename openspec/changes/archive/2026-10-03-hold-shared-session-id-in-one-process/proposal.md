## Why

A Claude Code conversation resumed in a second terminal while the first is still open gives two live processes whose session files name the same session id. The provider bound both, and the core keeps one session per id, so the session kept the first process's pid and status. When the first process exited, its `session:close` removed the session, and nothing reopened it: the second process was already bound, so its later rewrites reported status for a session the core no longer held.

A consumer that starts afterwards sees only the surviving process and looks correct. A long-lived watcher loses a working session until it restarts.

## What Changes

- **claude-code**: one session id is held by one process at a time. When several live processes name the same id, the one that started last holds it, and the others wait.
- A process taking over an id closes the session and opens it again with its own pid, status and journal.
- When the holder goes away, a waiting process's file is serviced again, so the session reopens under it.
- A waiting process rewriting its session file does not take the session back.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `claude-code-provider`: a session id named by several live processes is one session, held by the most recently started of them.

## Impact

- Code: `src/providers/claude-code/provider.ts`.
- Consumers see `session:close` then `session:create`/`session:open` for the same id when a second process takes a session over, and no longer lose the session when the first process exits.
- Other providers bind from open files rather than a pid index and are not changed.
