# all-your-agents

[![CI](https://github.com/markwylde/all-your-agents/actions/workflows/ci.yml/badge.svg)](https://github.com/markwylde/all-your-agents/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40markwylde%2Fall-your-agents)](https://www.npmjs.com/package/@markwylde/all-your-agents)

Watch every coding agent on this machine, and inspect the sessions they leave behind.

```ts
import AllYourAgents, { builtInProviders } from '@markwylde/all-your-agents';

const aya = AllYourAgents({
  providers: [...builtInProviders],
});

aya.on('session:create', (session) => {
  console.log(session.harness, session.id, session.pid);
});

aya.start();
```

No polling, ever ([ADR 0001](docs/adr/0001-never-poll.md)). `start()` watches the files each harness already writes and the processes that write them. Bursts are coalesced per path (about 25 ms quiet, at most 1 s behind). `stop()` drops every file and process watch. On macOS, where opening one `fs.watch` can make the others miss an event, each watch re-checks what it covers once after any watch opens or closes (see the ADR); a custom `fs` can opt in with `onWatchChurn`.

## Install

```sh
npm install @markwylde/all-your-agents
```

Node.js ≥ 20, macOS and Linux. Pass `{ fs, processes }` to observe a remote machine.

## Demos

Run straight from source on Node ≥ 22.18 (no build step):

```sh
node ./demo/list.ts          # every session, live and historical, as a table
node ./demo/list.ts --live   # only live sessions
node ./demo/watch.ts         # stream session events as they happen (Ctrl+C to stop)
```

## CLI

`all-your-agents` is `top` for coding agents. It lists every live session, puts the ones waiting on you first, and updates as they change. Press `H` for every session on the machine, finished ones included, and `t` to read what any of them said.

```sh
npx @markwylde/all-your-agents            # full-screen live view
npx @markwylde/all-your-agents --once     # print a table and exit (also when piped)
npx @markwylde/all-your-agents --json     # print live sessions as JSON and exit
npx @markwylde/all-your-agents --all      # also show sessions that close while it is open
npx @markwylde/all-your-agents --history  # start with every session, not only live ones
npx @markwylde/all-your-agents --json --history   # every session as JSON, live ones first
```

| Key | Action |
| --- | --- |
| `↑` `↓` / `k` `j`, `Home` `End`, `PgUp` `PgDn` | Move the selection |
| `Enter` | Details: full title and folder, what it is waiting for, current tool, last error, subagents |
| `/` | Filter by title, folder, harness, model, or pid. `Esc` clears |
| `s` `>` / `<`, `r` | Next / previous sort column, reverse |
| `c` | Show or hide closed sessions |
| `H` | Show or hide history: every session the providers know, in the same table |
| `t` | Transcript of the selected session: prompts, replies, tools, outcomes. Follows a live session. `t` or `Esc` closes |
| `?` `h` | Help |
| `q` `Ctrl+C` | Quit and restore the terminal |

The screen redraws only when an agent changes, a key is pressed, or the terminal resizes. History is read once when you press `H`; a transcript is one event stream, closed when you leave it. Times are clock times (`14:31:02`), not ticking durations, so nothing runs on a timer. `NO_COLOR` is honoured.

## Session object

Live sessions have a `pid`. Historical ones do not. `kind` is `interactive` or `headless`.

```ts
import type { Session, SessionActivity, Subagent, Turn, SessionEvent } from '@markwylde/all-your-agents';
```

`session.activity` is the current or last turn (`tool`, `lastTurn`, `error`, `openSubagents`), separate from `status`. `session.subagents()` lists launched subagents. `transcript()` yields `Turn`s; `events()` tails normalized `SessionEvent`s until you stop iterating or call `close()` on it (both work while it is waiting) (`user`, `assistant`, `tool`, `tool-result`, `title`, `turn-end`, `subagent`, `subagent-end`, `error`, `other`). Each item keeps the original record on `raw`.

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
| `error` | A provider failed (`{ source: 'provider', provider, error }`) or one of your listeners threw (`{ source: 'listener', event, error }`). Never thrown into the library. |

Subscribe before `start()`. Catch-up events carry `{ catchUp: true }`, then `ready`, then `{ catchUp: false }`.

A listener that throws never stops updates. Register an `error` listener to receive the failure; without one it is rethrown asynchronously as an uncaught exception, so it is never lost.

## Query

```ts
aya.running();
await aya.sessions({ harness, cwd, live, kind, since });
await aya.get(id);
await aya.reconcile(pid); // one-shot re-validation; never schedules
```

`since` is epoch ms matched against `updatedAt` (fallback `startedAt`). `kind` is `interactive` | `headless`. `sessions()` works without `start()`. `transcript()`, `events()` and `subagents()` are always served by the provider named in `session.provider`. Closed sessions stay in memory for the 1000 most recent; older ones come from their provider's history.

## Options

```ts
AllYourAgents({
  providers: [...builtInProviders],
  fs,            // default: local filesystem
  processes,     // default: local ps/proc + kqueue/pidfd via optional koffi
  debounce: { quietMs: 25, maxLatencyMs: 1000 },
});
```

`reconcile(pid?)` is for hosts that already know a process exited (a terminal emulator). Without `koffi`, `processes.watch` is `unsupported` and each provider re-validates on the next change to its live index or on `reconcile`.

## Claude Code

Provider id `claude-code`, harness `ClaudeCode`. Home is `$CLAUDE_CONFIG_DIR` if set, otherwise `~/.claude`, overridable via `claudeCode({ home })`.

Live index: `<home>/sessions/<pid>.json`. Journals: `<home>/projects/<encoded-cwd>/<id>.jsonl`. Every non-alphanumeric character in the cwd becomes `-`, so `/Users/me/app/.claude/worktrees/x` is `-Users-me-app--claude-worktrees-x`.

Status: `busy` → `running`, `waiting` → `waiting`, `idle`/`shell` → `idle`. Unknown words omit `status`. `model` is the model of the latest assistant record in the journal. `.key` files and the messaging socket are never opened.

## Grok Build

Provider id `grok-build`, harness `Grok`. Home is `$GROK_HOME` if set, otherwise `~/.grok`, overridable via `grokBuild({ home })`. Both built-ins are in `builtInProviders`; pass `providers: [claudeCode()]` to watch Claude Code only.

Live index: `<home>/active_sessions.json`, an array of `{ session_id, pid, cwd, opened_at }`. One pid can hold several sessions. `grok -p` registers only when `GROK_TRACK_HEADLESS` is set; otherwise print-mode runs appear in history with `kind` `headless`. Sessions: `<home>/sessions/<encoded-cwd>/<id>/`. The cwd is percent-encoded like Rust `urlencoding` (everything but `A-Za-z0-9-._~`, so `/tmp/foo(bar)!` is `%2Ftmp%2Ffoo%28bar%29%21`); a cwd whose encoding exceeds 255 bytes is found by a one-level lookup for the session id.

Status comes from `events.jsonl`, Grok's phase log: `waiting_for_model`, `streaming_text`, `streaming_reasoning`, `tool_execution` → `running`; `permission_prompt` → `waiting` (with the tool named by `permission_requested`); no open turn → `idle`. Unknown phases omit `status`. Titles and `model` come from `summary.json`, the conversation from `chat_history.jsonl`, subagents from `subagents/<id>/meta.json`. `active_sessions.lock`, `*.tmp`, `auth.json`, `updates.jsonl` and the session-search sqlite are never opened.

## Testing kit

```ts
import { defineConformanceTests, createMemoryHarness } from '@markwylde/all-your-agents/testing';

const { provider, driver } = createMemoryHarness();
defineConformanceTests({ name: 'memory', provider, driver });
```

`createGrokFixtureDriver(home)` drives the same kit against `grokBuild({ home })`.

## Non-goals

Launching agents, IPC sockets, inferring status from journals, Windows.
