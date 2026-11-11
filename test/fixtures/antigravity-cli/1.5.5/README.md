# AntiGravity CLI 1.5.5 evidence

Mappings were checked on macOS on 2026-11-10 against the installed agy 1.5.5 binary's embedded `third_party/gemini_coder/proto/trajectory.proto` and `third_party/jetski/cortex_pb/cortex.proto` descriptors, and against controlled local runs. The public antigravity-cli repository contains documentation/examples, not the implementation source. Committed test records are synthetic; no private conversation or generation prompts are included.

Observed independently of the fixture encoder:

- An interactive `run_command` approval persisted a generic step (type 132, status 9), metadata tool-call ID/name and requested_interaction field 56 containing permission field 21. The permissions column was still empty until approval. Approving once changed the same step to DONE.
- A real `ask_question` prompt persisted WAITING with requested_interaction.ask_question (22). The implemented reader returned waiting=true, waitingFor=ask, model=Gemini 4 Argon (Medium), and tool=ask_question while the prompt was open.
- Generation metadata stored the readable model at chat_model (1).model_display_name (21), associated with packed step_indices (2). Steps within the same execution have separate generation rows. Numeric model enum 1418 is an opaque placeholder, not a reliable display name.
- A response with tool calls had STOP_PATTERN (2), even though the turn continued. Therefore tool calls suppress normal response completion. Its final executor metadata recorded NO_TOOL_CALL (4), last_step_idx (3), and the execution ID (9).
- Existing child summaries and trajectory metadata agreed on parent/root IDs. SubagentSpec records type_name (1), role (2) and run_as_task (9). Deterministic tests cover nested/background relationships, cancelled/completed states, root membership and child WAL updates.
- Actual task_details columns were also embedded at Step field 148. A still-running daemon had is_daemon (6) and moved_to_background_at (8); cancelled foreground tasks lacked field 8. Daemons must not keep an idle session waiting.
- A real `agy --output-format=stream-json -p=...` run executing a harmless sleep was emitted as a live session with the CLI PID, then closed on process exit. Exit code was 0. Print mode does not require statusline/hooks.
- Older `.pb` files inspected were not plain protobuf. Generated transcript_full.jsonl logs recovered user/assistant history, but their tool calls lacked stable IDs. They are a text fallback, not equivalent to SQLite.

Regression coverage includes real SQLite/WAL writes and an actual held presence descriptor on macOS and in a Linux Docker container. The live probes made no source changes and used only session-local settings.
