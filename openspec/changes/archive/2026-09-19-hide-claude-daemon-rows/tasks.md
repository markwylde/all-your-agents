## 1. Session file fields

- [x] 1.1 Add `spare`, `jobId` and `parkedJobId` to the allowlist and `ParsedSessionFile` in `src/providers/claude-code/session-file.ts`, typed as boolean, string and string, and ignored if mistyped; verify with new cases in `test/providers/claude-code/session-file.test.ts`
- [x] 1.2 Add fixture session files for a spare, a claimed job and a parked interactive (copied shape from the 2.1.278 files, ids scrubbed) under `test/fixtures/claude-code/2.1/`; verify the fixtures test still passes

## 2. Spares

- [x] 2.1 In `provider.ts`, make `bind` return without emitting for a file with `spare: true`, and make `rewrite` close the bound session when a rewrite sets `spare: true`; verify with provider tests for "Pre-warmed spare", "Spare is claimed" and "Bound file becomes a spare"

## 3. Parked interactive sessions

- [x] 3.1 Add a `parked` map and hold a file whose `parkedJobId` matches a bound session's `jobId`; verify with the "Terminal hands its work to a job" and "Orphaned parked id" provider tests
- [x] 3.2 When a session with a `jobId` binds, close and park any bound session parked on it; verify with the "Job seen after the parked terminal" test
- [x] 3.3 When a job session closes, or a parked file is rewritten or deleted, drop it from `parked` and re-service it through the `inOrder` queue; verify with the "Job ends" test and a test that unparking by rewrite binds the session
- [x] 3.4 Clear `parked` in the watch teardown; verify a watch-close test leaves no pending handles

## 4. Spec and checks

- [x] 4.1 Add a provider test for "Daemon wrapper without a session file" (live pid, no file, no events); verify it passes
- [x] 4.2 Run `npm test` and `npm run lint` (or the scripts in `package.json`); verify both pass
- [x] 4.3 Run the CLI against the real `~/.claude` while a background job and a spare exist; verify one row per conversation
