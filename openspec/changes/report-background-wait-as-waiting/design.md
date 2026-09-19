## Context

See proposal.md for motivation. What each harness records, checked against live data on the author's machine:

| Harness | Background work that wakes the session | Where it is recorded | Reported today |
|---|---|---|---|
| Claude Code | background shell command | session file status word `shell` | `idle` (`shell` folded into `idle`) |
| Grok Build | backgrounded `run_terminal_command` (kind `bash`), `monitor` | `updates.jsonl`, `_x.ai/session/update` rows: `task_backgrounded`, `background_tasks` (snapshot with `kind`, `status`), `task_completed` | `idle` (`events.jsonl` has no such event or phase) |
| oh-my-pi | backgrounded `bash` | transcript `toolResult.details.async {state, jobId, type}`; closed by `custom_message` `async-result` or a `hub` result | `idle` (only `type: task` is read, for subagents) |
| Codex CLI | none. Unified exec lives inside a turn; nothing is delivered to an ended turn, and no in-progress exec state is persisted | — | `idle`, correctly |

Across 101 Grok sessions, `background_tasks` rows carried kinds `bash` (895) and `monitor` (270) only, with statuses `running`, `completed`, `failed`.

The claude-code half is already implemented in this worktree (`status.ts`, `provider.ts`, the mapping test, README). It predates this change and is kept; the tasks cover what is still missing around it.

## Goals / Non-Goals

**Goals:**
- One meaning across providers: turn over + wake-capable background work running = `waiting`, with `waitingFor` `shell` or `monitor`.
- Tests at three levels per provider: the pure status function, the provider against a fake home, and the shared conformance kit.

**Non-Goals:**
- A new `SessionStatus` value. The type stays `running | waiting | idle`.
- Changing how background subagents are reported, in any provider.
- Scheduled wakeups (Grok `scheduler_*`, Claude `ScheduleWakeup` / cron). Nothing on disk was verified for them; a session waiting only on a schedule stays `idle`.
- Exposing the task list itself (command, output file) on the session.
- Inferring anything for Codex.

## Decisions

**`waiting` + `waitingFor`, not a fourth status.** A new value such as `background` would break every exhaustive switch on `SessionStatus` in consumers and the CLI. `waitingFor` already exists to say what a wait is on. Alternative considered: report `running`. Rejected: the turn is over, `activity.lastTurn` is `completed`, and consumers show token spend and "doing now" for `running`.

**A small shared vocabulary for `waitingFor`.** `shell` and `monitor`, the same in every provider, so a consumer can tell "nothing is asked of me" with one check. Grok's kind `bash` and omp's type `bash` both become `shell`, matching Claude's own word. Alternative: pass harness words through (`bash`, `monitor`, `shell`). Rejected: consumers would need a per-harness table, which is what this library exists to remove. When several Grok tasks run, `monitor` wins because only a monitor is certain to wake the agent on output.

**Grok: read `updates.jsonl`.** It is the only file that records background tasks; `events.jsonl` and `resources_state.json` do not, and `chat_history.jsonl` carries them only as prose. The README said it is never opened because it is large (1.8 MB for a two-turn session, one row per streamed chunk). Cost is bounded the same way as `events.jsonl`: one read at bind, then a debounced tail. Rows are filtered on `method` before anything else, and cheaply: skip a line that does not contain `_x.ai/session/update` before `JSON.parse`. Alternative: pair "moved to the background" prose in `chat_history.jsonl` with later `<system-reminder>` completion notices. Rejected: prose matching, and the spec forbids status from chat history.

**Grok: snapshot is the truth, `task_completed` is a shortcut.** `background_tasks` replaces the whole task map; `task_completed` just flips one id. Grok writes both together, so either alone is enough, and handling both survives a torn tail.

**Task state lives next to turn state.** Grok: `EventsState` gains the running-task map and `deriveStatus` consults it only when `!turnOpen`. omp: `EventsState` gains `openJobs` and `deriveStatus` does the same. Status stays a pure function of reducer state, so the existing table tests extend naturally.

**Turn-end side effects stay tied to the turn ending, not to the word `idle`.** Claude already does this through `isIdleWord` (`shell` closes the turn and cancels foreground subagents). Grok's `endForeground` runs "on `idle`" today (`provider.ts:238`); it must run when the turn closes, whether the result is `idle` or `waiting`. omp's `markBackground` has the same shape. Each gets a test.

**omp: drop jobs from a dead process at bind.** A job belongs to the omp process that started it. The bind replay already interrupts a turn left open by an earlier process using the process start time; open jobs older than that are cleared the same way.

**Codex: a test, no code.** A rollout containing a unified-exec `exec_command` call followed by `task_complete` asserts `idle`, so nobody "fixes" Codex by guessing later.

## Risks / Trade-offs

- [Consumers alert on `waiting`] → Marked BREAKING in the proposal; README documents the `waitingFor` check; release as a minor bump with a changelog line. Terminay's sidebar is the known consumer.
- [`updates.jsonl` is an undocumented xAI extension and may change shape] → Unknown rows are ignored silently, a malformed known row is reported as a record failure, and without the file the provider behaves exactly as before. A compatibility fixture from a real session pins the shape.
- [A Grok task shown `running` forever because Grok died before writing completion] → The session closes on process exit, so the stale wait cannot outlive the process.
- [Tailing `updates.jsonl` adds read load during streaming] → Same debounce and ceiling as `events.jsonl`; the substring pre-filter avoids parsing chunk rows.
- [omp `hub` result shapes vary] → Reuse `reportedOutcomes`, which already parses `details.jobs[]` and `details.results[]`.

## Migration Plan

Ship as a minor version. Consumers that want the old reading can map `waiting` with `waitingFor` `shell` / `monitor` back to `idle` themselves. Rollback is reverting the change; no stored data is affected.
