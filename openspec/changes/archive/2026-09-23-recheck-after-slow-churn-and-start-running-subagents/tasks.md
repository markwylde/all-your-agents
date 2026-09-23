## 1. Late churn pass

- [x] 1.1 `watchDir`, `watchFile`, `tailJsonl`: queue a second catch-up at `maxLatencyMs` after churn on its own debouncer, disposed on close; verify with the injected clock that a burst causes two passes, a rewrite after the first pass is caught by the second, and no timer remains
- [x] 1.2 Update `docs/adr/0001-never-poll.md` for the second pass

## 2. Running subagents at bind

- [x] 2.1 codex-cli `seedAgents`: start a running child instead of seeding it; verify a child read before its parent binds gets exactly one `subagent:start`
- [x] 2.2 oh-my-pi `seedAgents`: the same; verify a running child at catch-up starts, an ended one does not, and one spawned while binding still starts
- [x] 2.3 Correct the oh-my-pi subagent requirement in `add-omp-provider`

## 3. Verification

- [x] 3.1 `npm run lint` and `npm test` pass; the CI matrix passes with the macOS test job re-run three times
