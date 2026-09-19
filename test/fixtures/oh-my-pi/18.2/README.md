# oh-my-pi fixtures

Captured on 2026-09-19 from `omp` 18.2.6 (`@oh-my-pi/pi-coding-agent`, checkout `78b7531`) running `--model grok`, then scrubbed: every free-text value (prompts, replies, thinking, tool arguments and output, titles, system prompts, error text) is replaced by a placeholder, signatures and provider payloads are dropped, paths and session ids are rewritten. Entry structure, types, ids, timestamps, stop reasons and tool names are as omp wrote them.

| File | What it is |
| --- | --- |
| `root.jsonl`, `root.children/*.jsonl` | Two turns; the second spawns three background `task` agents and waits on them with `hub`. Ends with `session_exit` (`/exit`). |
| `nested.jsonl`, `nested.children/**` | Headless `omp -p`. One agent spawns another: the nested transcript lands in `<Parent>/<Parent>.<Child>.jsonl` and its header names the parent's transcript. |
| `ask-wait.jsonl` | An `ask` tool call that blocked for two minutes, then a long turn. Ends with a `session_exit` from SIGHUP. |
| `error-turn.jsonl` | A first turn that failed with a provider error (`stopReason: error`). |
| `print-mode.jsonl` | `omp -p`, one turn. Nothing in it marks the run as headless. |
| `aborted-turn.synthetic.jsonl` | **Synthetic.** `stopReason: aborted` could not be provoked through the terminal driver; shaped after `error-turn.jsonl` and `StopReason` in `packages/ai/src/types.ts`. |
| `presence.json`, `breadcrumb-fresh`, `breadcrumb` | The registry files as written at launch, and the breadcrumb after the transcript materialised. |
| `history.json` | The `history` table's schema and this run's rows (prompts replaced). |

`expected-*.json` are snapshots. Regenerate with `AYA_UPDATE_FIXTURES=1`.
