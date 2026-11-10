# Design

## Context

The package already has injected read-only SQLite access and open-file holder probes. agy 1.5.5 stores summaries in conversation_summaries.db, steps with protobuf payloads in conversations/<uuid>.db, and holds presence/<uuid>.lock. Local schema inspection and the installed binary's embedded protobuf descriptors establish field numbers and enum values; no private conversation contents will become fixtures.

## Goals / Non-Goals

Implement a provider isolated from the core and reuse its event semantics. No CLI execution, IPC, new dependencies, schema writes, auth reads, legacy .pb decoding or subagent lifecycle guesses. Kind and human model names remain unset unless explicitly persisted in supported fields.

## Decisions

- Use held presence locks, not database holders: SQLite handles may belong to a shared backend or transient reader. Probe holders only on startup, relevant notifications and reconcile. A missing holders implementation means history only.
- Query only explicit summary columns and bounded step payloads through ctx.sqlite. Validate UUIDs before constructing paths; reject children, unsupported step formats and malformed payloads. No FTS or generation-metadata reads.
- Watch presence and conversations directories for discovery; watch summaries DB/WAL and bound conversation DB/WAL with heldOpen. Serialize updates and guard asynchronous work with a stopped flag so shutdown cannot resurrect watchers.
- Decode the small supported protobuf wire subset with bounded lengths and varints. Read user_response field 2 inside step field 19; response field 1 inside step field 20; metadata field 5 contains tool_call and timestamps. Tool events use explicit tool-call identifiers and names. Finalized mutable steps are emitted once; pending rows are revisited on notifications. Numeric enums are mapped only where verified against embedded descriptors.
- Keep unknown bookkeeping records out of transcript. Completion requires a terminal stop reason, failure or cancellation; a tool-use response alone cannot finish a turn. Live activity is derived from normalized events using the existing TurnFact contract.

## Risks / Trade-offs

- Undocumented schema drift → narrow validated decoding, synthetic fixtures, document version and limits.
- Summary fields may lag → observe step waiting states and database/WAL changes; unknown remains unknown.
- Lock close does not itself notify → process exits close immediately; reconcile or a later relevant event discovers silent release.
- SQLite unavailable on Node 20 → provider yields nothing; other providers remain functional.
- Metadata SQLite reads can fail while storage changes → report asynchronous errors and retry only upon the next event.

## Migration Plan

Additive export and built-in registration; consumers can select providers explicitly to opt out. Rollback removes registration and export without touching agy data.

## Versioned mapping and stream policy

For agy 1.5.5: `conversation_summaries` columns conversation_id, title, workspace_uris, status, parent_conversation_id, last_modified_time; roots have empty/null parent. Require an existing `<uuid>.db`. Timestamps are SQLite UTC datetime strings converted to epoch milliseconds; workspace_uris is a JSON array of local file URLs. Read only these columns. Match id in SQL and filter since after validated time parsing.

`steps` are ordered by integer idx >=0; step_format must be 0. Query idx, step_type, status and step_payload only, bounding each payload to 4 MiB in SQL before retrieval. Protobuf varints are bounded to ten bytes and safe integers where consumed, length-delimited fields to remaining bytes; reject malformed messages. USER_INPUT=14 (step field 19, user_response=2), PLANNER_RESPONSE=15 (field 20, response=1, tool_calls=7, stop_reason=12). Metadata is step field 5: created_at=1, completed_at=8, tool_call=4, model_info=24 (model_name=8). Timestamp seconds/nanos become milliseconds. ChatToolCall id=1, name=2, arguments_json=3. Keep other payload fields opaque. Reasoning fields are never exposed.

Step status PENDING=1, RUNNING=2, DONE=3, INVALID=4, CLEARED=5, CANCELED=6, ERROR=7, GENERATING=8, WAITING=9, QUEUED=11, INTERRUPTED=12. Finalized rows (3,4,5,6,7,12) advance the stream cursor; pending rows block later emission until finalized. Malformed finalized rows are skipped, not guessed. Each row is emitted at most once per stream; post-final edits are not replayed. Database inode replacement ends an inspect follower and rebuilds a live binding. Unknown-format finalized rows advance without events. Tool call metadata yields a tool event and terminal tool rows a result; tool failure alone does not end a turn.

STOP_PATTERN=2 and MAX_TOKENS=3 complete a response turn; FUNCTION_CALL=10 leaves it open. ERROR=13 and CLIENT_* failures 17..20 fail it; CLIENT_CANCELED=16 interrupts it. Unknown/incomplete reasons leave it open. Row cancellation interrupts the turn; explicit error-message type 17 fails it. No generic tools are named from numeric type values.

Summary IDLE means idle and overrides stale step waiting. RUNNING/BUSY/CANCELING mean running, overridden by latest validated step WAITING to waiting. Unknown summary state omits status. Binding replays all supported finalized rows into activity once with `activity:replay`; later rows emit incremental turn facts. Summary titles use harness precedence.

Each watch invocation owns independent state. Queue all notification and reconcile work. Close invalidates the binding identity before its watches are released; every awaited bind/read checks both stopped and binding identity. Process exit immediately invalidates the binding even with queued I/O. Watch before the initial scan; complete queued initial work before ready. Reconcile(pid) touches only that PID's bindings; discovery notifications can validate other roots. A silent handle release is discovered only on reconcile or a relevant notification. Missing probes mean history only. Missing SQLite means no sessions.
