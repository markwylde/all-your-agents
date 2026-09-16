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

No polling, ever ([ADR 0001](docs/adr/0001-never-poll.md)). `start()` watches the files each harness already writes and the processes that write them. When a session appears, opens, changes status, or closes, you get an event. Bursts are coalesced per file (about 25 ms quiet, at most 1 s behind), so a session writing thirty times a second is parsed about once a second. `stop()` drops the watches.

## Why this exists

Claude Code, Codex, Grok, OpenCode, and the rest each dump session state somewhere under `$HOME`. None of them expose a shared API for "what is running right now" or "what did that session do." This library is that API.

The first provider is Claude Code. The public surface is generic so the next harness is a provider, not a fork.

## Install

```sh
npm install all-your-agents
```

Node.js, local filesystem. This is not a cloud product.

## Quick start

```ts
import AllYourAgents, { builtInProviders } from 'all-your-agents';

const aya = AllYourAgents({
  providers: [...builtInProviders],
});

aya.on('session:create', (session, { catchUp }) => {
  // brand-new conversation, live process
});

aya.on('session:open', (session, { catchUp }) => {
  // existing conversation, new process
});

aya.on('session:status', (session, { catchUp }) => {
  // session.status is 'running' | 'waiting' | 'idle'
});

aya.on('session:close', (session, { catchUp }) => {
  // process no longer holds it; the transcript is still inspectable
});

aya.on('ready', () => {
  // catch-up finished; events after this are live
});

await aya.start();

const live = aya.running();
const past = await aya.sessions();

await aya.stop();
```

Subscribe before `start()`. The first burst is catch-up: every session already live is emitted as `session:create` or `session:open`, then `session:status`, each with `{ catchUp: true }`. Then `ready` fires. After that, `catchUp` is `false`.

## Session object

Every event carries the same `Session`. Live sessions have a `pid`. Historical ones do not.

```ts
type Harness = 'ClaudeCode' | 'Codex' | 'Grok' | 'OpenCode' | string;

type SessionStatus = 'running' | 'waiting' | 'idle';

type WaitingFor =
  | 'permission prompt'
  | 'input needed'
  | 'dialog open'
  | 'sandbox request'
  | 'goal proposal'
  | string;

type SessionKind = 'interactive' | 'sdk' | 'remote' | 'worker' | 'subagent' | string;

interface Session {
  id: string;                 // harness session id (Claude: UUID)
  harness: Harness;           // which CLI
  provider: string;           // provider id, e.g. 'claude-code'
  kind?: SessionKind;         // how the process was started
  pid?: number;               // set while a process holds it
  cwd?: string;               // current cwd; may differ from where the journal lives
  title?: string;
  status?: SessionStatus;
  waitingFor?: WaitingFor;    // only when status is 'waiting'
  model?: string;
  version?: string;           // harness version, e.g. '2.1.273'
  permissionMode?: string;    // harness-specific word, e.g. 'bypassPermissions'
  startedAt?: number;         // epoch ms
  updatedAt?: number;         // epoch ms
  closeReason?: 'clean' | 'stale';  // set after session:close

  transcript(): AsyncIterable<Turn>;
  events(): AsyncIterable<SessionEvent>;
  children(): AsyncIterable<ChildSession>;
}

interface ChildSession {
  id: string;                 // e.g. Claude agent id
  agentType?: string;         // e.g. 'Explore'
  description?: string;
  toolUseId?: string;         // tool call that spawned it
  spawnDepth?: number;
  transcript(): AsyncIterable<Turn>;
}
```

`transcript()` replays the stored conversation. `events()` tails it: historical records first, then live appends until the iterator is closed. Neither call polls; the tail is a file watch.

`children()` lists subagents spawned by the session. They are not sessions in `running()`; they hang off their parent.

**Title precedence.** `title` is resolved in this order, first hit wins: a user-set custom title, a harness-derived name (Claude: `name` in the pid file, or `agent-name` in the journal), an AI-generated title. Providers must not synthesise a title from the first prompt.

**Turn is a whitelist.** Only `user`, `assistant`, and `system` records become `Turn`s. Everything else a harness writes into its journal is bookkeeping and is skipped, never guessed at.

```ts
aya.on('session:create', async (session) => {
  for await (const turn of session.events()) {
    if (turn.type === 'user') console.log(turn.text);
    if (turn.type === 'tool') console.log(turn.name);
  }
});
```

## Events

Session events are `session:<verb>`. First argument is the `Session` after the change. Second is `{ catchUp: boolean }`.

```ts
type EventMeta = { catchUp: boolean };
```

| Event | When |
| --- | --- |
| `session:create` | A live process owns a conversation that did not already have a journal. |
| `session:open` | A live process owns a conversation that already had a journal, or the process switched to one. |
| `session:status` | The harness published a new status word. |
| `session:update` | Metadata changed: title, cwd, model, permissionMode. |
| `session:close` | The process no longer holds the conversation. `session.closeReason` says how. |
| `ready` | Catch-up from `start()` has finished. |
| `error` | A provider hit something it could not parse. Payload is `{ provider, path, error }`. Never thrown. |

There is no `session:running`. Status is a field, not a family of events. `session:status` fires when it changes, including the first time after create/open.

**`create` vs `open`.** Decided at the moment the live record appears, with one rule: if that `id` already has a transcript on disk, it is `open`; otherwise it is `create`. We do not wait for a journal to show up later, and we do not correct `create` into `open`. A pid-file rewrite that names a different `sessionId` is `session:close` on the old id (same pid, no longer holding it) then `session:open` on the new one.

Mapped from Claude Code's own words:

| Claude `status` | `session.status` |
| --- | --- |
| `busy` | `running` |
| `waiting` | `waiting` |
| `idle`, `shell` | `idle` |

Other harnesses map into the same three. If a provider cannot tell, `status` is omitted rather than guessed.

`session:close` does not delete history. The same `id` still comes back from `aya.sessions()` and from `transcript()`. `pid` is gone from that session after close.

`closeReason` is `'clean'` when the harness removed its own live entry, and `'stale'` when the entry is still on disk but the pid is dead or belongs to a different process. Stale entries are reported once and then ignored.

## Query

```ts
aya.running(): Session[]
await aya.sessions(filter?: {
  harness?: Harness;
  cwd?: string;
  live?: boolean;
}): Session[]

await aya.get(id: string): Session | undefined
```

- `running()` is the in-memory live set. Cheap, no disk walk after start.
- `sessions()` includes closed conversations the providers know about (Claude: JSONL journals under `~/.claude/projects`).
- `get` looks up by harness session id.

## Lifecycle

```ts
const aya = AllYourAgents({ providers });

await aya.start();  // begin watches; emit catch-up; then `ready`
await aya.stop();   // unwatch, no more events
```

`start` is idempotent. `stop` is idempotent. Nothing is watched until `start()`.

If a provider's home directory does not exist yet, the library watches the parent for that directory to appear. It does not sit in a retry loop.

## Providers

```ts
const aya = AllYourAgents({
  providers: [...builtInProviders, myProvider],
});
```

`builtInProviders` is the shipped set. Today that is Claude Code. Codex, Grok, and OpenCode land as more entries in the same array.

A provider is the only place a harness's filesystem layout is allowed to leak:

```ts
interface Provider {
  id: string;
  harness: Harness;

  // Subscribe to live process + status changes. Call emit; never setInterval.
  watch(ctx: WatchContext): Promise<Unwatch> | Unwatch;

  // Historical conversations this harness left on disk.
  list?(ctx: ListContext): AsyncIterable<SessionSnapshot>;

  // Open a transcript by id, live or not.
  inspect?(ctx: InspectContext, id: string): AsyncIterable<SessionEvent>;
}
```

`watch` must be event-driven: `fs.watch`, FSEvents, kqueue, inotify, and process exit notifications through `ctx.processes.watch`. A timer that re-reads a path to see if it changed is a bug. Confirming a pid once at bind time is fine. Scraping `ps` on an interval is not. Use `ctx.fs`, never `node:fs`, so a host can point the same provider at a remote machine. See [ADR 0001](docs/adr/0001-never-poll.md).

Discovery is "a session file appeared," not "scan every process and guess."

## How Claude Code is watched

This is the reference provider. Others should feel like this, not like a process table.

**Live index** — `~/.claude/sessions/<pid>.json`

Every interactive `claude` writes one of these for itself, rewrites it when the conversation or status changes, and removes it on exit. A create of `<pid>.json` is `session:create` if that `sessionId` has no journal yet, otherwise `session:open`. A rewrite whose `sessionId` changed is `session:close` on the old id then `session:open` on the new one. A rewrite of `status` is `session:status`. Unlink is `session:close`.

Shape we actually read (Claude Code 2.1.x):

```json
{
  "pid": 63665,
  "sessionId": "7c30d9ac-21d5-4175-bc1f-70c128f5478f",
  "cwd": "/Users/mark/Documents/Projects/terminay/terminay",
  "startedAt": 1789590056603,
  "procStart": "Wed Sep 16 20:20:56 2026",
  "version": "2.1.273",
  "kind": "interactive",
  "name": "terminay-ee",
  "nameSource": "derived",
  "status": "idle",
  "statusUpdatedAt": 1789590057306,
  "updatedAt": 1789590057306
}
```

Only `pid`, `sessionId`, `cwd`, `startedAt`, `procStart`, `version`, `kind`, `status`, `statusUpdatedAt`, `waitingFor`, `name`, and `nameSource` are used. The sibling `<pid>.<digest>.key`, `messagingSocketPath`, `peerProtocol`, and `peerFeatures` are never opened or interpreted.

A file is accepted only when its `pid` matches the filename, `sessionId` is a UUID, and `procStart` matches that process's start time. That last check is what stops a recycled pid from resurrecting a crashed session. `procStart` is a `ctime`-style string in UTC; `ps -o lstart` prints local time, so compare as epochs, not strings. A file that fails validation is reported once via `error` and then ignored.

**Kinds.** Claude writes `kind` as one of `interactive`, `sdk`, `remote`, `worker`, or `subagent`. All are surfaced with `session.kind` set; nothing is filtered out by default. Consumers that only care about terminals filter on `kind === 'interactive'`.

**Waiting.** When `status` is `waiting`, `waitingFor` is one of `permission prompt`, `input needed`, `dialog open`, `sandbox request`, or `goal proposal`. It is passed through verbatim.

**Transcript** — `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`

The project directory is the cwd with slashes turned into dashes (`/Users/you/app` → `-Users-you-app`). The journal stays in the directory the conversation started in, and the cwd moves more often than you would think: a resume from elsewhere, or entering a worktree (`relocated` and `worktree-state` records). Lookup order:

1. Derived path from the pid file's `cwd`.
2. `.session-aliases` in that project directory, which Claude writes as a list of other project directories to check.
3. One bounded lookup for that exact `<sessionId>.jsonl` under `.claude/projects`.

Each line is a JSON object. `user` / `assistant` / `system` are the conversation and become `Turn`s. Everything else is bookkeeping and is skipped: `attachment`, `ai-title`, `custom-title`, `agent-name`, `last-prompt`, `mode`, `permission-mode`, `atis-latch`, `queue-operation`, `bridge-session`, `cost-state`, `frame-link`, `relocated`, `worktree-state`, `file-history-snapshot`, `file-history-delta`, `summary`, `pr-link`, and any future type.

A few bookkeeping records do feed `Session` fields, without becoming turns:

| Record | Field |
| --- | --- |
| `custom-title` | `title` (highest precedence) |
| `agent-name` | `title` |
| `ai-title` | `title` (lowest precedence) |
| `permission-mode` | `permissionMode` |
| `relocated` | `cwd` |
| `assistant` → `message.model` | `model` |

**Subagents** — `<sessionId>/subagents/agent-<id>.jsonl` next to the journal, with a sibling `agent-<id>.meta.json` holding `agentType`, `description`, `toolUseId`, and `spawnDepth`. These back `session.children()`. Child transcripts, not extra live roots.

**Not used as the live index**

- `~/.claude/session-env/<sessionId>/` — one directory per session ever started, created at launch and almost always empty. It is a config-dir scratch space, not a live index, and it is never cleaned up, so its presence says nothing about whether the session is running.
- `~/.claude/history.jsonl` — prompt history with `sessionId` and `project`. Useful for search later, not for liveness.
- Journal mtime, "newest jsonl in the project," or `lsof`. Two terminals in one repo share a project directory; only the pid file says which journal belongs to which process.

## Custom provider sketch

```ts
const alwaysEmpty = {
  id: 'example',
  harness: 'Example',
  watch({ emit, watchDir }) {
    return watchDir('/tmp/example-sessions', (event) => {
      if (event.type === 'create') {
        emit('session:create', parse(event.path));
      }
    });
  },
};

const aya = AllYourAgents({
  providers: [...builtInProviders, alwaysEmpty],
});
```

Helpers like `watchDir` are provided so a custom provider does not invent its own watcher, debounce, or catch-up scan.

## Non-goals (for now)

- Launching or sending input to agents.
- Talking to Claude's IPC socket or reading `.key` files.
- Inferring status from the last journal line. The harness's own status file is the source.
- Windows as a first target. macOS and Linux first.

## Status

API is being designed in this README. Implementation follows it.
```
