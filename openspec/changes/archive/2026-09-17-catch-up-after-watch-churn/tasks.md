## 1. The churn signal

- [x] 1.1 Add optional `onWatchChurn` to `Fs` in `src/helpers/types.ts`; implement it in `src/helpers/fs.ts` with a process-wide listener set fired on watch open and close, on `darwin` only; verify with a test that listeners fire on open and on close, stop after unsubscribe, and that the member is absent on other platforms

## 2. Helpers catch up

- [x] 2.1 `tailJsonl`: subscribe before opening the watch, verify with `requestRead` through the coalescer, honor a read requested during the first read, unsubscribe on close; verify with a scripted `Fs` that an append with no notification is yielded once after churn
- [x] 2.2 `watchFile`: remember the last serviced size and mtime, verify by comparing, unsubscribe on close; verify with a scripted `Fs` for change, delete, re-create and unchanged
- [x] 2.3 `watchDir`: keep a size/mtime baseline per entry (taken in the initial scan and on every service), verify by listing and comparing, check for the directory while waiting for it, unsubscribe on close; verify with a scripted `Fs` for a silent change, create and delete, that unchanged entries are neither reported nor re-read, and that a missing directory created silently is picked up
- [x] 2.4 Verify with a scripted `Fs` and an injected clock that ten churns cause one pass per helper, that no timer remains after the pass, and that a closed helper does nothing

## 3. Against the real filesystem

- [x] 3.1 Add a macOS-only stress test: 200 files created in a directory watched by `watchDir` while other watches open and close around every write, all 200 reported; confirm it fails with `onWatchChurn` removed from the local filesystem
- [x] 3.2 Remove the fixed `settle()` waits the earlier tests needed after opening a watch where the catch-up now covers them, and verify the provider and helper test files exit cleanly 20 times in a row

## 4. Docs and verification

- [x] 4.1 Record the limitation, its cause and this mechanism in `docs/adr/0001-never-poll.md`, and note in the README that host `fs.watch` calls are not seen; verify the ADR's "no timer while idle" wording still holds
- [x] 4.2 Run `npm run lint`, `npm test`, and the whole suite five times; verify all pass
- [x] 4.3 Run `openspec validate catch-up-after-watch-churn --strict`; verify it passes
