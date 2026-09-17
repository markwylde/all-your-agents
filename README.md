# all-your-agents

Watch every coding agent on this machine, and inspect the sessions they leave behind.

```ts
import AllYourAgents, { builtInProviders } from 'all-your-agents';

const aya = AllYourAgents({
  providers: [...builtInProviders],
});

aya.on('session:create', (session) => {
  console.log(session.harness, session.id, session.pid);
});

aya.start();
```

No polling, ever ([ADR 0001](docs/adr/0001-never-poll.md)). `start()` watches the files each harness already writes and the processes that write them. Bursts are coalesced per path (about 25 ms quiet, at most 1 s behind). `stop()` drops every file and process watch.

## Install

```sh
npm install all-your-agents
```

Node.js ≥ 20, macOS and Linux. Pass `{ fs, processes }` to observe a remote machine.

## CLI

`aya` is `top` for coding agents. It lists every live session, puts the ones waiting on you first, and updates as they change.

```sh
npx aya            # full-screen live view
npx aya --once     # print a table and exit (also when piped)
npx aya --json     # print live sessions as JSON and exit
npx aya --all      # also show sessions that close while aya is open
```

| Key | Action |
| --- | --- |
| `↑` `↓` / `k` `j`, `Home` `End`, `PgUp` `PgDn` | Move the selection |
| `Enter` | Details: full title and folder, what it is waiting for, current tool, last error, subagents |
| `/` | Filter by title, folder, harness, model, or pid. `Esc` clears |
| `s` `>` / `<`, `r` | Next / previous sort column, reverse |
| `c` | Show or hide closed sessions |
| `?` `h` | Help |
| `q` `Ctrl+C` | Quit and restore the terminal |

The screen redraws only when an agent changes, a key is pressed, or the terminal resizes. Times are clock times (`14:31:02`), not ticking durations, so nothing runs on a timer. `NO_COLOR` is honoured.

## Session object

Live sessions have a `pid`. Historical ones do not. `kind` is `interactive` or `headless`.

```ts
import type { Session, SessionActivity, Subagent, Turn, SessionEvent } from 'all-your-agents';
```

`session.activity` is the current or last turn (`tool`, `lastTurn`, `error`, `openSubagents`), separate from `status`. `session.subagents()` lists launched subagents. `transcript()` yields `Turn`s; `events()` tails normalized `SessionEvent`s (`user`, `assistant`, `tool`, `tool-result`, `title`, `turn-end`, `subagent`, `subagent-end`, `error`, `other`). Each item keeps the original record on `raw`.

**Title precedence**, highest first: `user` (custom title) > `harness` (generated) > `process` (session-file name) > `prompt` (first real user prompt). `session:update` fires only when the effective title, cwd, or model changes.

## Events

| Event | When |
| --- | --- |
| `session:create` | A live process owns a conversation that did not already have a journal. |
| `session:open` | A live process owns a conversation that already had a journal. |
| `session:status` | Status changed (`running` \| `waiting` \| `idle`). |
| `session:update` | Effective title, cwd, or model changed. |
| `session:activity` | `session.activity` changed. |
| `session:close` | The process no longer holds it. `pid` is unset; history remains. |
| `subagent:start` / `subagent:end` | A subagent launched or finished. |
| `ready` | Catch-up from `start()` finished. |
| `error` | A provider threw. Payload `{ provider, error }`. Never thrown. |

Subscribe before `start()`. Catch-up events carry `{ catchUp: true }`, then `ready`, then `{ catchUp: false }`.

## Query

```ts
aya.running();
await aya.sessions({ harness, cwd, live, kind, since });
await aya.get(id);
await aya.reconcile(pid); // one-shot re-validation; never schedules
```

`since` is epoch ms matched against `updatedAt` (fallback `startedAt`). `kind` is `interactive` | `headless`. `sessions()` works without `start()`.

## Options

```ts
AllYourAgents({
  providers: [...builtInProviders],
  fs,            // default: local filesystem
  processes,     // default: local ps/proc + kqueue/pidfd via optional koffi
  debounce: { quietMs: 25, maxLatencyMs: 1000 },
});
```

`reconcile(pid?)` is for hosts that already know a process exited (a terminal emulator). Without `koffi`, `processes.watch` is `unsupported` and the provider re-validates on the next `sessions/` event or `reconcile`.

## Claude Code

Provider id `claude-code`, harness `ClaudeCode`. Home is `$CLAUDE_CONFIG_DIR` if set, otherwise `~/.claude`, overridable via `claudeCode({ home })`.

Live index: `<home>/sessions/<pid>.json`. Journals: `<home>/projects/<encoded-cwd>/<id>.jsonl`. Every non-alphanumeric character in the cwd becomes `-`, so `/Users/me/app/.claude/worktrees/x` is `-Users-me-app--claude-worktrees-x`.

Status: `busy` → `running`, `waiting` → `waiting`, `idle`/`shell` → `idle`. Unknown words omit `status`. `.key` files and the messaging socket are never opened.

## Testing kit

```ts
import { defineConformanceTests, createMemoryHarness } from 'all-your-agents/testing';

const { provider, driver } = createMemoryHarness();
defineConformanceTests({ name: 'memory', provider, driver });
```

## Non-goals

Launching agents, IPC sockets, inferring status from journals, Windows.
