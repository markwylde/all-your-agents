# Design

Support agy 1.5.5's persisted conversation state through the injected Fs, Sqlite and Processes interfaces. Never execute agy, change its configuration, read credentials or poll in the provider.

Use held presence locks for root liveness. Watch summaries, conversation databases and WALs before initial reads; serialize notifications and invalidate bindings on exit, deletion or replacement. Child conversations belong to their root and do not need independent CLI processes.

Decode the embedded gemini_coder Step/Trajectory and cortex protobuf schemas. SQLite steps remain authoritative. Read generation metadata for human model names and execution/step association; executor metadata supplies terminal outcomes even when generation fails without a response. Expose user/assistant/tool/error events with original rows, keeping reasoning opaque. Resolve requested_interaction into approval, question or elicitation waiting reasons. Pending tool starts are visible immediately; completed results appear once. Unfinished background tasks cannot block later conversation records. Retain pending indices for later completion and deduplicate emitted events across notifications.

Follow child summaries and trajectory metadata recursively, validating parent/root UUIDs and rejecting cycles. Subagent specs supply type, role and background mode; persisted terminal outcomes and killed flags supply lifecycle. Inspect child streams only after checking root membership. Watch child DB/WAL files while the root is live.

Read generated legacy transcript logs with a bounded file read where no SQLite database exists; older .pb files are not plain protobuf and are not decrypted. Prefer SQLite during migration. The legacy fallback exposes text and explicit terminal text records; absent stable tool IDs and metadata are not synthesized. Do not infer interactive/headless kind from the controlling terminal: print mode can also have a TTY. Support headless sessions via the same presence ownership and persisted records.

Bound payload sizes and page SQLite rows. Unknown schemas remain unknown. No private historical conversations become committed fixtures. Tests cover live mutations, background gaps, model changes, failures, nested subagent lifecycle, legacy history, abort and replacement. Controlled real agy probes validate wire mappings independently of synthetic fixtures.
