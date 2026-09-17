## Context

See proposal.md for the defect and its cause. Constraints:

- ADR 0001: nothing may be re-read on a clock, and no timer may exist while nothing changes. A debounce armed by an event and disarmed after firing is allowed.
- The defect belongs to the process, not to an instance: libuv has one FSEvents stream per event loop. Two instances, or an `events()` tail opened by a consumer, disturb each other's watches.
- Providers and the core reach the filesystem only through `Fs` and the three watch helpers. `inspect` calls `tailJsonl(ctx.fs, path)` directly, outside any `WatchContext`.
- The helpers already own a coalescer each, with an injectable clock that the timing tests drive.

## Goals / Non-Goals

**Goals:**
- A change that lands while any watch in the process opens or closes is serviced within the debounce window.
- Cost proportional to what is watched, paid only when a watch opens or closes.
- No plumbing through contexts, and no behavior change for a filesystem that does not have the defect.

**Non-Goals:**
- Watches opened with `fs.watch` by the host application. They are invisible to the library.
- Replacing `fs.watch` on macOS (for example kqueue vnode watches through `koffi`). That is a larger change with its own failure modes (one descriptor per file, no directory contents), and the optional dependency would become load-bearing.
- Linux. inotify watches are independent; adding or removing one does not disturb the others.

## Decisions

### 1. The signal lives on `Fs`, not on a context
`Fs.onWatchChurn?(listener): () => void`. The local filesystem keeps one process-wide listener set and calls it from `watchPath` on open and on close, on `darwin` only.

Alternatives:
- A hub object created per instance and passed to the helpers through `WatchContext`: misses `inspect` tails, other instances, and anything else in the process using the local filesystem, which are all real sources of churn.
- A module-level hub inside the helpers, independent of `Fs`: would fire for remote or in-memory filesystems that have no such defect, and could not fire for a remote filesystem that does.

Putting it on `Fs` states the truth: it is a property of how that filesystem's watches behave. It is optional, so every existing `Fs` implementation stays valid.

### 2. Each helper re-verifies itself, through its own coalescer
On churn a helper calls `coalescer.notify('churn:' + path, verify)`. Reusing the coalescer gives the burst behavior, the latency ceiling, the injected clock the tests already drive, and disposal on close for free. The delay also matters for correctness: verifying at the instant of the open would run before libuv has finished rebuilding the stream, and a write a few milliseconds later would still be lost with nothing left to catch it.

Alternative: one central debounce in the local filesystem that then calls the listeners. Rejected: it would need its own clock and timer outside the helpers' injected one, and the timing tests could no longer see or drive it.

### 3. What "verify" means per helper
- `tailJsonl`: `requestRead()`. It already stats first and returns when the size has not moved. The read queued during the first read is now honored when that read finishes, since churn can ask for a read before it has.
- `watchFile`: remembers the `{ size, mtimeMs }` it last reported (or that the file was absent). Verify stats and reports only a difference. A real notification still always reports, as today.
- `watchDir`: `known` becomes a map from name to the `{ size, mtimeMs }` last serviced. The initial scan stats each entry for its baseline before reporting it, so whatever the consumer reads in response to `create` is at least as new as the baseline. Verify lists the directory, services names that appeared or vanished through the normal path, and for the rest compares a fresh stat with the baseline, reporting `change` only on a difference. While waiting for a missing directory, verify is the existing existence check.

Size and mtime are sufficient: an append changes size, an atomic rename-over changes mtime, and APFS and ext4 mtimes have sub-millisecond resolution. A rewrite to identical size within the same mtime tick is not distinguishable, and is equally invisible to the content the consumer would read.

### 4. A helper's own open is churn
The helper subscribes before it opens its watch, so its own open schedules a verify about 25 ms later. That closes the startup window as well (a write just after the watch opens, before the stream is live), which the test suite had been working around with a fixed wait.

### 5. It terminates
Verify opens a watch only when it finds a real change of structure (a missing directory appeared, a watched directory vanished). That open is churn and schedules another verify, which finds nothing and arms nothing. With no change there is no open, so no loop.

## Risks / Trade-offs

- [A directory with thousands of entries is listed and statted on every churn] → the only directories watched are `sessions/` (one entry per live process), a session's `subagents/`, and a project directory while a journal is awaited. None grows with history.
- [Verify reports a `change` the real notification also reports] → consumers already treat `change` as "re-read", and the baseline is updated by whichever comes first, so the second finds no difference in the common order. A duplicate `change` is harmless by ADR 0001's own rule.
- [Tests that assert "no timers" right after a watch opens now see a churn debounce for 25 ms] → that is the same in-flight debounce the ADR allows; such tests wait for it like any other debounce.
- [Host `fs.watch` calls still disturb the stream] → documented. A host can route its watches through `createLocalFs().watch` to be seen.
