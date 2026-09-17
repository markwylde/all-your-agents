## Why

On macOS an established `fs.watch` can miss an event that lands while another watch in the same process is being opened or closed. libuv serves every watch from one FSEvents stream and, on each add or remove, destroys it and creates a new one starting from "now" (`src/unix/fsevents.c`: `uv__fsevents_reschedule` → `uv__fsevents_destroy_stream` → `uv__fsevents_create_stream` with `kFSEventStreamEventIdSinceNow`). Whatever happens during the rebuild is never delivered. Measured here: 6 of 200 writes missed while other watches opened and closed, 0 of 200 without.

This library opens watches constantly (a journal tail, a subagents directory and one tail per subagent for every session), so one session binding can swallow another session's status rewrite. ADR 0001 tolerates a dropped event because "state converges on the next notification", but a session that has just gone `waiting` may not write again until the user answers, which is exactly the state the user needs to see.

## What Changes

- The filesystem interface gains an optional `onWatchChurn(listener)`: a filesystem whose watches can drop events while another watch opens or closes calls the listener after each such open or close. The local filesystem implements it on macOS, process-wide, because libuv's stream is per process.
- Every watch helper (`watchDir`, `watchFile`, `tailJsonl`) subscribes while it is open and, after churn, re-verifies once what it covers: one `stat` per known entry or tailed file, servicing only what changed. The pass goes through the helper's existing coalescer (25 ms quiet, 1 s ceiling), so a burst of opens costs one pass and the pass runs after the stream has been rebuilt.
- To compare, `watchDir` and `watchFile` remember the size and mtime they last serviced. `watchDir`'s initial scan takes that baseline.
- ADR 0001 records the limitation and why this is not polling: the trigger is the library's own action, never a clock, and nothing is armed while no watch is opening or closing.

A helper's own open counts as churn, so this also covers an entry that changes in the first moments after its watch opens.

Not covered: watches a host application opens with `fs.watch` directly, outside this library's filesystem. They rebuild the same stream but the library cannot see them.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `harness-providers`: the filesystem interface gains `onWatchChurn`, and the shared watch helpers catch up after watch churn.

## Impact

- `src/helpers/{types,fs,watch-dir,watch-file,tail-jsonl}.ts`, `docs/adr/0001-never-poll.md`, README.
- No provider or core change: providers only use the helpers.
- Cost: one `stat` per watched entry per pass; passes happen only when a watch opens or closes. No new dependency.
