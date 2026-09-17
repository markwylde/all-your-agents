## 1. Executable and packaging

- [x] 1.1 Rename `src/cli/aya.ts` to `src/cli/main.ts`, set `bin` to `{ "all-your-agents": "dist/cli/main.js" }`, and change the `aya:` error prefixes and `Usage: aya` text to `all-your-agents`; verify `test/cli/*.test.ts` pass with the updated expectations
- [x] 1.2 Add `"prepack": "npm run build"` and `author` to `package.json`, and refresh `package-lock.json`; verify `npm pack --dry-run` lists `dist/cli/main.js`
- [x] 1.3 Update `test/pack.test.ts` to run `node_modules/.bin/all-your-agents` and assert no `.bin/aya` exists; verify the pack test passes
- [x] 1.4 Update the README CLI section to `npx all-your-agents`; verify `grep -rnw aya README.md package.json src` finds only instance variable names

## 2. Error model and listener isolation

- [x] 2.1 Replace `ProviderError` with the `AgentsError` union in `src/types.ts` and `src/index.ts`, and emit `source: 'provider'` everywhere the core emits `error`; verify `tsc` and the type tests in `test/types` pass
- [x] 2.2 Wrap listener calls in the core's `emit`: report as `source: 'listener'`, rethrow via `queueMicrotask` when there is no `error` listener or an `error` listener throws; add registry tests for both scenarios in the spec and verify they fail before and pass after
- [x] 2.3 Make `makeWatchCtx` per-provider and add `reportError` to `WatchContext`; add a registry test that a report after `watch()` yields one `error` with that provider id
- [x] 2.4 Show listener errors in the CLI status line labelled with the event name; verify with a `test/cli/state.test.ts` and `render.test.ts` case

## 3. Core session handling

- [x] 3.1 Route `transcript()`, `events()` and `subagents()` by provider id and delete the `providers[0]` fallback; add a two-provider registry test that fails before the change
- [x] 3.2 Make `attachSession` the single session builder, remove the `live` branch of `snapshotToSession`, and simplify the merge in `sessions()`; add a test that a live session has identical own keys from an event, `running()`, `sessions()` and `get()`
- [x] 3.3 Make `stop()` forget live sessions' titles and subagents; add a test that stop then start re-emits `subagent:start` with `catchUp: true`
- [x] 3.4 Bound `history` to the 1000 most recently closed sessions, evicting titles and subagents with it; add a test that closes 1001 memory-provider sessions and checks `get()` for the oldest and newest

## 4. Watch helpers

- [ ] 4.1 Add the `backlog: 'separate'` option and `backlog` promise to `tailJsonl`, and thread it through `TailJsonlFn` and `makeWatchCtx`; add a test with a counting `Fs` proving the initial bytes are read once and iteration yields only appends
- [ ] 4.2 Decode with a streaming `TextDecoder` in `tailJsonl`, reset on truncation; add a test that splits a multi-byte character across two appends
- [ ] 4.3 Open the watch before the initial scan in `watchDir`, skip already-known names in the scan, and fall back to the ancestor watch when `fs.watch` throws; add a test using an `Fs` wrapper that creates an entry during `readDir` and expects exactly one create
- [ ] 4.4 Re-arm `watchDir` when the watched directory is removed; add a test that removes and re-creates the directory and sees the delete then the new create
- [ ] 4.5 Never open a watch after `close()`: re-check `closed` after every await in `watchDir` before calling `fs.watch`; add a test that closes during the initial scan and asserts no watch handle is left open

## 5. Claude Code provider

- [ ] 5.1 Seed from `tail.backlog` and handle iterated records as live, deleting the separate whole-file read and the `skipping` counter; add a provider test with a counting `Fs` asserting the journal is read once at bind and an appended record is handled once
- [ ] 5.2 Wrap per-record handling in the root and child tail loops with `ctx.reportError`; add a provider test where a listener-independent failure on one record is reported and a later tool-use record still sets `activity.tool`
- [ ] 5.3 Add `modelOf` to `journal.ts`, emit `model` at seed and on live assistant records, and include `model` in `list` snapshots; add tests for bind, mid-session switch, `<synthetic>`, and history listing
- [ ] 5.4 Remove `staleFiles`, `Bound.stale`, `Bound.activity`, the empty branch in `handleRecord`, the no-op `system` chain in `mapRecord`, and the duplicated `contentOf`/`textOf` in `activity.ts`; verify the captured-journal fixture test output is unchanged
- [ ] 5.5 Never attach a journal, subagents directory or child tail to a session that was torn down while the attach was awaiting (found as an intermittent test-process hang from a leaked watch); add a provider test with a slow `Fs` that stops mid-bind and asserts every watch handle is closed; verify `provider.test.js` exits cleanly 20 times in a row

## 6. Verify

- [ ] 6.1 Run `npm run lint` and `npm test`; verify both pass with no new skips
- [ ] 6.2 Run `node dist/cli/main.js --json` against the real `~/.claude`; verify a live session that has replied shows a `model`
- [ ] 6.3 Run `openspec validate harden-for-first-release --strict`; verify it passes
