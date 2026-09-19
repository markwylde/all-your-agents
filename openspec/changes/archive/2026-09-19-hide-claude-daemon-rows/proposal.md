## Why

The Claude Code background daemon writes `<home>/sessions/<pid>.json` files for processes that are not conversations a person is running, and the provider turns each one into a live row. On a real machine one conversation showed up as three rows: the interactive terminal that had handed its work to a background job, the job itself, and an unused pre-warmed spare with its session id as its title.

## What Changes

- Session files marked `"spare": true` (pre-warmed daemon processes nobody has claimed) no longer produce live sessions. When the daemon claims a spare and rewrites its file without the marker, it is bound like any other session file. A bound file that is rewritten as a spare is closed.
- An interactive session file whose `parkedJobId` names the `jobId` of another accepted, live session file is hidden while that job is live. The job's row carries the conversation. When the job goes away, or the interactive file drops `parkedJobId`, the interactive session is bound again.
- The provider reads three more session-file fields: `spare`, `jobId` and `parkedJobId`.
- `bg-pty-host` wrapper processes and unclaimed spares with no session file already produce no rows; this is now stated in the spec, with no code change.
- History listing (`list`) is unchanged. It reads journals, and spares have none.

## Capabilities

### New Capabilities

### Modified Capabilities
- `claude-code-provider`: the live index reads `spare`, `jobId` and `parkedJobId`; new requirements hide unclaimed spares and interactive sessions parked on a live background job.

## Impact

- `src/providers/claude-code/session-file.ts`: parse and allow the three new fields.
- `src/providers/claude-code/provider.ts`: skip spares during bind and rewrite; keep parked files aside and re-bind them when their job closes or they are unparked.
- Tests under `test/providers/claude-code/` (session-file and provider).
- No change to the core, the CLI or other providers.
