# ADR 0002: Prefer a harness's own process registry

Status: accepted
Date: 2026-09-19

## Decision

To learn which sessions are live, a provider first looks for a directory where the harness keeps one small file per live process or live session. If the harness has one, the provider watches that directory, and that watch is how it discovers sessions. Only a harness with no such directory gets a fallback design. Before we design that fallback, someone has to have listed the harness's home directory and checked, on a real run, what appears there and when it goes away.

Examples:

- **Claude Code** writes `~/.claude/sessions/<pid>.json` for each running process. We watch that directory. A new file is a new process. The file tells us the session id and cwd, so there is nothing to guess.
- **Codex** writes `~/.codex/thread-writer-locks/<thread-id>.lock` whenever a process opens a thread for writing: a new session, `codex resume`, or `codex exec resume`. The process holds the lock open while the thread is live. The file name is the thread id, and one `holders` probe on the lock gives the pid. (Codex 0.155.1, checked live: a TUI resume creates the lock within about 2 s of launch, before any prompt, and a later Codex start deletes unheld locks and recreates its own.)

A registry entry is not proof of life, because a crashed process can leave its file behind. So we still check the process when we bind (ADR 0001 allows one-time probes), and we still watch it for exit. What the registry gives us is the event that says to look, and the id of the thing to look at.

## Why

- **One watch, fixed cost.** A registry directory is small and flat. Watching it costs one watch, however many sessions exist in history.
- **It fires when a session starts.** The harness writes its registry entry when the process or thread starts, not on the first transcript append. A resumed session shows up before the user types anything.
- **It names the session.** The file name or contents say which session it is. We don't have to infer it from mtimes, file sizes or which files are newest.
- **It doesn't depend on how writes get reported.** On macOS, a directory watch (FSEvents, recursive or not) reports nothing for writes through a handle the writer keeps open, until the handle closes. Transcripts are exactly that kind of file. Registry entries are created and deleted, and those events are reported promptly on every platform.

## What went wrong without it

The first Codex provider found sessions by watching the dated `sessions/YYYY/MM/DD` folders for transcript writes, then probing which process held the transcript open. Nobody had checked `~/.codex` for a registry. That design broke in three places:

1. A resumed session wrote nothing until the first prompt, so it was invisible until then.
2. On macOS, the directory watch never saw Codex's appends, because Codex holds the transcript open. A resume stayed invisible until Codex quit.
3. The workaround, watching the 64 most recent transcripts one by one, needed a cap. Each watch is an open fd, so `lsof` listed aya itself as a holder, and aya bound itself as dozens of sessions.

The registry was sitting in `~/.codex` the whole time.

## Consequences

- A proposal for a new provider must say whether the harness keeps a registry, and give the evidence: a directory listing and a live run showing an entry appear and disappear. "No registry" also needs that evidence.
- When a harness keeps a registry, transcript watching is only for reading content: status, turns and titles. It is never how we discover sessions.
- A fallback that watches transcripts must say why no registry exists, and how it copes with held-open writes on macOS.
- If a harness adds a registry in a later version, we switch to it for that version, and keep the fallback only for older versions we still support.
