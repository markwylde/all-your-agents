## Why

The project's goal is exploring every agent on a computer, and the library already lists historical sessions and replays transcripts. The terminal UI exposes neither: it shows live sessions only, so a session that finished yesterday, or what a running agent actually said, cannot be seen without writing code.

## What Changes

- A **history view** in the TUI: `H` loads every session the providers know (live and historical) into the same table, where the existing sort, filter, selection and detail view apply. `H` again goes back to live only. `--history` starts in it.
- A **transcript view**: `t` on the selected session, live or historical, shows its conversation (prompts, replies, tool calls and failures, subagent launches, turn outcomes), scrollable, opened at the latest turn. For a live session it follows new records as they are written.
- One-shot output gains `--history`: `--once --history` and `--json --history` print every session, not only live ones.
- The detail view works for historical sessions, including their subagents.
- `session.events()` gains `close()`, and stopping works while the consumer is waiting for the next record. Today an idle tail cannot be cancelled: an async generator queues `return()` behind the pending `next()`, so a viewer that closes leaves the journal watched.

Nothing here polls. History is read once when `H` is pressed; the transcript is one `events()` stream that the view closes when it closes.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `aya-cli`: adds the history view, the transcript view, and the `--history` flag; the executable's flag list and one-shot output change accordingly.
- `agent-sessions`: `events()` can be closed, including while waiting.
- `harness-providers`: `inspect` receives an `AbortSignal` and stops following when it aborts.

## Impact

- `src/cli/{args,state,rows,render,run,table,keys}.ts`, a new `src/cli/transcript.ts`, and their tests.
- README CLI section and usage text.
- Library: `Session.events()` and `Subagent.events()` return `SessionEventStream` (`AsyncIterable<SessionEvent> & { close(): void }`), `InspectContext` gains `signal`; `src/core/instance.ts`, `src/types.ts`, `src/provider.ts`, `src/providers/claude-code/provider.ts`. Additive: existing `for await` consumers are unaffected.
- No new dependency.
