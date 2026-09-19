## Context

The live index is built from `<home>/sessions/<pid>.json` files. `parseSessionFile` in `session-file.ts` keeps an allowlist of fields, and `bind`/`rewrite` in `provider.ts` turn each accepted file into one session keyed by pid. Nothing looks at relationships between files.

The files that caused the extra rows on a real machine (Claude Code 2.1.278):

| pid | kind | relevant fields | what it is |
| --- | --- | --- | --- |
| 46009 | interactive | `parkedJobId: "7a6f4abc"` | terminal that handed its conversation to a background job |
| 46329 | bg | `jobId: "7a6f4abc"` | claimed spare now running that job |
| 46439 | bg | `spare: true`, `jobId: "e32386cc"` | pre-warmed spare, never used, no journal |

The `bg-pty-host` wrappers and a second spare (46353) have no session file, so they already produce nothing.

## Goals / Non-Goals

**Goals:**
- One row per conversation a person is actually running.
- Rows come back when the thing hiding them goes away, with no restart.

**Non-Goals:**
- Showing which terminal a job is parked from, or merging the two into one row with both pids.
- Changing how `kind: "bg"` maps. It stays `headless`.
- Inspecting process command lines. The session file stays the only source.

## Decisions

**Filter spares in the provider, not in `parseSessionFile`.** The parser keeps the `spare` flag and the provider decides. A bound file that turns into a spare has to be closed, and only the provider knows what is bound. Alternative: reject spares in the parser. Rejected because `serviceFile` treats a rejected parse as "do nothing", which would leave a stale bound session open.

**Keep parked files in a `parked` map, keyed by pid.** When `bind` receives a file with a `parkedJobId` that matches the `jobId` of a bound session, it stores the parsed file and file path in `parked` and binds nothing. When a session binds with a `jobId`, any bound session parked on that id is closed and moved to `parked`. When a session closes (`emitClose`/`teardown` paths), parked entries waiting on its `jobId` are re-serviced through `serviceFile` so they pass validation again. A rewrite or delete of a parked file removes it from `parked` before normal handling. Alternative: hide every file with `parkedJobId` set. Rejected because a job that crashes without clearing the field would hide the terminal for good.

**Hide the terminal and show the job.** The job's file carries the live status, the auto name ("Opencode support") and the journal being written. The parked terminal's file is stale (`status: idle`, last updated when it parked). This is recorded as an assumption; if Claude Code later exposes the terminal as the primary process, the choice flips in one place.

**Defer parked files during the initial scan.** Files are serviced concurrently at start-up, so a terminal can be read before its job. A file with a `parkedJobId` and no live job yet is set aside until the scan is done, then serviced. After start-up, an unmatched `parkedJobId` binds straight away.

**Re-service parked files in order.** Re-binding goes through the existing per-path `inOrder` queue, so it cannot race a concurrent rewrite of the same file.

## Risks / Trade-offs

- [The terminal's row flickers at start-up when its file is scanned before the job's] → During the initial scan, parked files with no live job yet are deferred and serviced after every other file, so `watch` resolves with the terminal already hidden.
- [Claude Code renames or removes `spare`/`jobId`/`parkedJobId`] → The rows come back, which is how it behaves today. A fixture under `test/fixtures/claude-code/2.1` records the current shape.
- [A job's `jobId` is claimed by two files] → Treat any live match as hiding. Both jobs still show.
