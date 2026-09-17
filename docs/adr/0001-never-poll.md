# ADR 0001: We never poll

Status: accepted
Date: 2026-09-16

## Decision

`all-your-agents` learns that something changed only from the operating system telling it so. There is no code path, in the core, in a helper, or in any provider, that re-reads a path, re-runs a command, or re-scans the process table on a timer.

Concretely:

- **Files and directories** are watched with the kernel's notification facility (FSEvents/kqueue on macOS, inotify on Linux) through `fs.watch`. A watch is the only reason a file is ever re-read after its first read.
- **Processes** are watched with the kernel's process-event facility: `kqueue` `EVFILT_PROC` (`NOTE_EXIT`, `NOTE_FORK`, `NOTE_EXEC`) on macOS, and `pidfd_open` readiness on Linux. Node has no built-in for this, so the calls go through `koffi` (an FFI with prebuilt Node-API binaries), with the blocking wait on a dedicated worker thread. Spawn and exit arrive as events. Where that source is unavailable, liveness is re-checked only when some other event for that session fires (a session-file rewrite, a journal append, a sibling entry changing) or the consumer calls `reconcile`. It is never re-checked on a clock.
- **One-time probes are allowed.** Reading a process's start time when a session is first bound, or checking that a pid exists at that moment, is a single system call made in response to an event. That is not polling.
- **Consumers may nudge.** A host that has its own process facts (a terminal emulator that owns the pty, for example) can call `reconcile(pid)` to ask for a one-time re-validation. That is an event from the consumer, not a timer.

## Debounce, with a ceiling

Kernel notifications arrive in bursts. A busy Claude Code session appends to its journal and rewrites its session file many times a second, and a single logical write often produces several notifications (`rename` + `change`, or one per chunk). Reacting to every notification would parse the same file dozens of times for one meaningful change.

So every watch coalesces:

- **Trailing debounce per path.** After a notification, wait a short quiet window (default 25 ms) before reading. Further notifications for the same path inside the window restart it.
- **Maximum latency per path.** The quiet window may not be restarted indefinitely. If a path has been changing continuously, it is read no later than a fixed ceiling (default 1000 ms) after the first un-serviced notification, and the window starts again from there.

The effect: a file written 30 times a second is parsed about once a second, not 30 times, and a file that never goes quiet is still never starved. A single write is seen about 25 ms after it lands. Both numbers are configuration on the helper, not constants scattered through providers.

A debounce timer is armed only by a notification and disarms after firing. While nothing changes, no timer exists. The test suite asserts this by wrapping `setTimeout`/`setInterval` during idle windows and failing on any timer that is not owned by an in-flight debounce.

## Why

- **Cost.** Polling `~/.claude` and the process table every second is measurable CPU and disk on a laptop running ten agents. Event delivery is free until something happens.
- **Latency.** A poller sees a change on its next tick, which is on average half the interval late. A watch sees it in milliseconds.
- **Correctness.** Polling invites heuristics: "newest file", "mtime within N seconds", "process seen twice in a row". Each is a guess that drifts. An event says exactly which path or pid changed, so the reaction can be exact: re-read that one file, re-validate that one pid.
- **Auditability.** With a no-timers rule, "does this library poll?" is a test, not a code review.

## Consequences

- Chokidar and similar polling-fallback libraries are out. The watch helpers are ours and small, so their behaviour is auditable against this rule.
- A watched directory that does not exist yet is handled by watching its nearest existing ancestor and re-arming as each level appears. There is no "try again in a second".
- A process that dies without removing its session file is detected through the process-event source. Until that source exists on a platform, the session closes on the next event that touches it, and consumers with better process facts call `reconcile`. Neither path uses a timer.
- Dropped or merged kernel events are tolerated because every reaction re-reads the whole target: state converges on the next notification rather than accumulating deltas.
- One kind of dropped event is not left to the next notification, because there may not be one. On macOS, libuv serves every `fs.watch` in a process from a single FSEvents stream, and each time a watch is added or removed it destroys that stream and creates a new one starting from "now" (`uv__fsevents_reschedule` in `src/unix/fsevents.c`). An event that lands during the rebuild is delivered to nobody. This library opens and closes watches whenever a session or subagent starts or ends, so one session binding could swallow another's status rewrite, and a session that has just gone `waiting` may not write again until someone answers it. So the local filesystem announces every watch it opens or closes (`Fs.onWatchChurn`, macOS only), and each helper then looks once at what it covers: one `stat` per known entry or tailed file, servicing only what differs from what it last serviced. The pass goes through the helper's debounce, so a burst of opens costs one pass and it runs after the rebuild rather than during it. This is not polling: the trigger is the library's own action, never a clock, and while no watch is opening or closing nothing is armed. A watch the host opens with `fs.watch` directly disturbs the same stream but is invisible to the library; a host that needs to can open it through `createLocalFs().watch`.
- The debounce ceiling means a status flip that lands and reverts inside one window (busy → idle → busy within 25 ms) is reported as its settled value. That is the intended meaning of status.
- Providers written for other harnesses inherit the rule through the shared helpers and the conformance kit's no-timers case. A provider that needs a timer to work is a provider that needs a different design.
