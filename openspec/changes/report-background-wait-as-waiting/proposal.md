## Why

A session that has ended its turn but left a background shell command or monitor running, which will wake it when it reports, is shown as `idle`. Consumers render `idle` plus a completed turn as "done", so an agent that is still working on the user's behalf looks finished. Seen live in Claude Code (status word `shell`) and Grok Build (a running `monitor`).

## What Changes

- A session whose turn is over while background work that will wake it is still running reports `status: waiting`, with `waitingFor` naming the kind of work (`shell` or `monitor`), instead of `idle`. It returns to `running` when woken and to `idle` when the work ends without waking it.
- **claude-code**: the session file's `shell` status word maps to `waiting` / `waitingFor: shell` instead of `idle`. The turn still ends when `shell` is written.
- **grok-build**: the provider starts reading `updates.jsonl`, which it was specified never to open, for Grok's background task rows (`background_tasks`, `task_completed`). A task still `running` after `turn_ended` gives `waiting` / `waitingFor: shell` (kind `bash`) or `monitor`.
- **oh-my-pi**: a `bash` result that was backgrounded (`details.async`, `state: running`) opens a job, closed by the `async-result` message or a `hub` result naming it. An open job after the turn ends gives `waiting` / `waitingFor: shell`.
- **codex-cli**: no behaviour change. Codex has no background work that wakes a session and persists no in-progress state for unified exec, so it keeps reporting `idle`. A test pins this.
- Background subagents are unchanged everywhere: they stay `running` on the subagent surface and do not by themselves make the session `waiting`.
- **BREAKING** for consumers that treat `waiting` as "needs the user": they must now check `waitingFor` (`shell` / `monitor` mean nothing is asked of the user).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-sessions`: `waiting` also covers a wait on background work; `waitingFor` values `shell` and `monitor` are reserved for it.
- `claude-code-provider`: status mapping of the `shell` word.
- `grok-build-provider`: status mapping reads background tasks; `updates.jsonl` joins the read and watch surface.
- `oh-my-pi-provider`: status accounts for open background bash jobs. This capability is still in the unarchived `add-omp-provider` change, so the delta here adds a requirement rather than modifying one; archive `add-omp-provider` first.

## Impact

- Code: `src/providers/claude-code/{status,provider}.ts`, `src/providers/grok-build/{events,provider,paths}.ts` plus a new updates reader, `src/providers/oh-my-pi/{events,journal,provider}.ts`, the conformance drivers in `src/testing/`.
- Docs: README provider sections, including the list of Grok files that are never opened.
- CLI: no code change expected; the `waiting` count and the `Waiting for` detail line now include background waits.
- Consumers (Terminay sidebar): a background wait stops rendering as DONE; attention badges keyed on `waiting` should exclude `shell` / `monitor`.
