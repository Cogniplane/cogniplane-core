# Agent runtime

Scope: the in-process Deep Agents runtime, session types and turn lifecycle, the
streaming contract, and the scheduler. The sandbox is in [sandbox](sandbox.md).
[Configuration](../configuration.md) owns the defaults of the environment
variables named here.

## Runtime adapter and graph

- `DeepAgentsRuntimeAdapter`
  (`services/deep-agents/deep-agents-runtime-adapter.ts`) implements
  `RuntimeAdapter`. It is the only runtime. It builds a `createDeepAgent` graph
  per session on demand and runs each turn as a LangGraph `streamEvents` v2
  stream. `getAgentForModel` (`deep-agents-graph.ts`) caches the compiled graph
  by model, effort and spending metering; a capability refresh drops it.
- `deep-agents-graph.ts` builds the graph:
  - Model: see [models](models.md).
  - State: see [Session types](#session-types).
  - Sandbox: the E2B backend when the tenant allows command execution. Otherwise
    there is no sandbox and no `execute` tool, and file tools use the deepagents
    `StateBackend` (graph state).
  - MCP tools: `GatewayMcpClient` (one `@langchain/mcp-adapters` adapter per
    server) calls the backend gateway over streamable HTTP. Servers load in
    parallel; a broken server drops only its own tools. A tool name that
    collides with a deepagents built-in (`RESERVED_BUILTIN_TOOL_NAMES`) or with
    another server is dropped with a warning.
  - Approvals: an `interruptOn` map. See [approvals](approvals.md).
  - Skills: a read-only `/skills/` library. See [skills](skills.md).
- Subagents: deepagents does not add custom middleware to its default
  `general-purpose` subagent, so `deep-agents-graph.ts` redefines it. When you
  add a guard or middleware to the root agent, add it to that override too
  (`generativeUiContextMiddleware` stays root-only on purpose).
- The system prompt is built at session start: tenant developer instructions,
  the memory tool rule, and skill names and descriptions. Project instructions,
  saved memories and generative-UI context enter the model input through
  middleware, not through the system prompt.
- `deep-agents-graph.test.ts` pins the deepagents built-in tool names. A library
  update that changes them fails this test. Update the test and the reserved
  list together.

## Session types

| | Normal chat | Project chat |
|---|---|---|
| Graph state | Postgres checkpointer, `thread_id` = session id | In-memory checkpoints for the life of the runtime; each turn rebuilds history from saved user and assistant messages |
| Runtime | Kept between turns until idle teardown or invalidation | New runtime for each turn, under the identity of the member who sends it |
| Sandbox binding | Sandbox id saved; any replica reconnects while it exists; archive, delete, purge and a security change of the owner's account kill it ([sandbox](sandbox.md#e2b-sandbox)) | Not saved; disposing the runtime kills its sandbox |
| Workspace files | Kept across turns while the sandbox exists | Kept for one turn only |
| Personal skills and defaults | Yes | No |

A project chat gives each turn its own runtime, runtime token and sandbox, also
when the same member sends two turns in a row. So the files of a turn are gone
at the next turn:

- When command execution is on, the workspace note in the system prompt tells
  the model (`workspaceLifetime: "turn"`, `deep-agents-graph.ts`).
- When the saved tool results show that the previous turn ran `write_file`,
  `edit_file` or `execute`, the first turn of the new runtime shows a
  `Workspace reset` notice (`previousTurnWithWorkspaceWrites`,
  `deep-agents-runtime-adapter.ts`). The check reads the saved transcript, so
  it works on every replica and after an idle teardown. A reset notice that an
  administrator action queued replaces it.
- Limits: there is no notice when the previous turn has no saved tool results,
  wrote files only through a subagent (subagent tool calls are not saved), or
  failed before its run started.

## Checkpointer

- `deep-agents-checkpointer.ts` runs LangGraph `PostgresSaver` in schema
  `deep_agents` on its own named `app_user` pool. `migrate.ts` creates the
  tables.
- The checkpoint tables have no tenant column and no RLS. Before any code reads
  or writes a checkpoint, it must resolve the session through the RLS-scoped
  `sessions` table and check access.
- Idle teardown keeps the thread. Permanent session deletion purges it.

## Sessions and turns

- Session routes (`routes/sessions.ts`): list, create, rename, `archive`,
  `restore` (from trash, else un-archive), delete (to trash; purge follows
  [retention](data.md#retention-and-deletion)), messages, connect, interrupt.
  Per-session capability selection: `routes/session-capabilities.ts`.
- A turn holds a session execution lease (`session_executions`,
  `SESSION_EXECUTION_LEASE_MS`, renewed by a heartbeat). A second turn on the
  same session gets `session_busy`: 429 when this replica runs the turn, 409
  when another replica holds the lease. `MAX_RUNNING_TURNS_PER_USER` and
  `MAX_RUNNING_TURNS_PER_TENANT` cap running turns (429 `running_turn_limit`).
- `RUNTIME_IDLE_TIMEOUT_MS` (`idle-teardown.ts`) tears down an idle session
  runtime. It kills the sandbox only when no binding is saved (project chats); a
  bound sandbox stays until E2B expires it, and the next turn reconnects. The
  conversation resumes as in [Session types](#session-types).
- `RUNTIME_TURN_TIMEOUT_MS` aborts a stuck turn and is paused while an approval
  waits; `0` turns it off. Its relation to the other timeouts: [startup
  rules](../configuration.md#startup-rules).
- Error text (`clientSafeTurnFailureMessage`): `Error` instances with a 4xx
  status and `ToolContextUnverifiedError` (also when wrapped in `cause`) pass
  their message to the client. Other errors get a generic message;
  `GraphRecursionError` has a fixed one. A 4xx status does not prove that
  provider text is safe to show.

### Turn finalization

`TurnTranscript` (`services/turn-transcript.ts`) finalizes interactive and
scheduled turns:

- It classifies the outcome as `completed`, `interrupted`, or `error`, and saves
  text and status first. If that write fails or updates no row, the turn cannot
  report success.
- Reasoning, plan, notices and tool results follow as best-effort writes.
- A tool call with no result can be stored as `in_progress` or `failed`
  (`turn-transcript.ts`, `message-store.ts`); how it shows: [tool
  cards](chat-ui.md#tool-cards).
- The SSE writer owns wire output, mid-turn checkpoints and MCP App events. It
  releases turn admission once, after finalization and before the terminal
  event.
- A mid-turn checkpoint saves `streaming` and the text so far. Before the final
  write, the writer waits for a checkpoint in flight for at most
  `CHECKPOINT_DRAIN_DEADLINE_MS` (`sse-stream-writer-agui.ts`). The store saves
  `pending` or `streaming` only on a row that has one of these statuses, so a
  checkpoint that arrives after the final write changes nothing.
- Finalization does not retry runtime or tool actions.

## Reconnect and stop

- `GET /sessions/:sessionId/connect` (`routes/sessions.ts`) gives the browser
  one ordered stream:
  1. saved history as a finished run;
  2. the running turn from its start;
  3. live events.

  The route captures the turn before it reads history. Replay is not safe when
  the local capture overflowed, the replay range is gone, or the saved reply
  does not match. Then the route sends the history with `activeTurn:
  "unavailable"`. The browser waits for the turn to end and loads the final
  state.
- Turn events are also appended to a Redis stream per turn
  (`services/turn-coordination-bus.ts`, bounded by `MAX_EVENTS` and `MAX_BYTES`,
  with a key expiry), so a connection on another replica can replay a running
  turn. `services/turn-event-log.ts` redacts these events: it holds back text
  until a secret that spans several deltas is complete, and it replaces
  private-key blocks with `[REDACTED PRIVATE KEY]`. Text without whitespace,
  such as Chinese or Japanese, is released in parts, cut where no secret rule
  can match across the cut. Keep this when you change the replay path.
- `POST /sessions/:sessionId/interrupt` fences the execution in the database.
  The replica that runs the turn sees the fence through dispatch authorization
  and its heartbeat, and dispatches no further model or tool call; a sandbox
  command already running continues ([sandbox](sandbox.md#sandbox-network)). A
  Redis stop channel makes this faster.

## Streaming contract

- `POST /messages` sends AG-UI `BaseEvent` values (`@ag-ui/client` schemas) as
  data-only SSE frames, with no `event:` lines.
- Cogniplane payloads (approvals, runtime notices, tool metadata and status, MCP
  Apps) are AG-UI `CUSTOM` events. `CogniplaneCustomEventSchema`
  (`packages/shared-types/src/schemas/custom-events.ts`) defines them; add new
  events there.
- `write_todos` updates `/plan` with `STATE_DELTA`.
- The route hijacks the reply, so it sets CORS headers itself with
  `isCorsOriginAllowed`.

## Scheduler

Users manage jobs on the page `/settings/scheduled-jobs` (API
`/me/scheduled-jobs`, `routes/settings.ts`: list, preview, create, update, runs,
delete). Limits: `SCHEDULED_JOB_CREATE_LIMIT_*` and
`SCHEDULED_JOB_MAX_ACTIVE_PER_USER`.

- `services/scheduler-worker.ts` polls `scheduled_jobs` every
  `SCHEDULER_POLL_INTERVAL_MS` and runs each due job as an unattended agent
  turn. Many replicas can run the worker.
- The claim (`UserSettingsStore.claimJob`) is one conditional `UPDATE ...
  RETURNING` and the insert of a `pending` row in `scheduled_job_runs`, in one
  transaction as `app_user` in the job's tenant. Only one replica gets the job,
  and each claim leaves one run row. The worker then links the run to its new
  session and writes the outcome, also when the session or the turn cannot
  start. After a crash, the stale-run sweep marks the run `failed`.
- Limits: `SCHEDULER_MAX_CONCURRENT_JOBS`, `SCHEDULER_JOB_TIMEOUT_MS`,
  `SCHEDULER_MAX_CONSECUTIVE_FAILURES` (disables a failing job).
- Turn order (`UserSettingsStore.listDueJobs`): the free slots go to one due
  job per tenant in each round. The tenant whose last run started first goes
  first. In a tenant, members take turns in the same way. A member's own jobs
  go oldest due first. The claim records the run start (`last_run_at`), so the
  next list on any replica reflects committed claims. A replica can still
  use a list it read before another replica claimed a job, so dispatch order
  across replicas is not strict. The order counts runs, not run time,
  and a due job still waits for a free slot.
- A scheduled turn cannot pause for approval: an enforced Policy Center
  `require_approval` match is denied, and so is every call that needs user
  consent ([memory](memory.md)).
- A job keeps the owner's security version
  ([revocation](local-accounts.md#security-version-and-revocation)).
- No code reads `settings_snapshot_json`. A new or edited job stores `{}`, not
  a copy of the owner's [user settings](data.md#user-settings), so a large
  section cannot make every job row larger. A job that an earlier version
  saved keeps its snapshot until its next edit, and the API still returns the
  field as `settingsSnapshot`.
- An interrupted scheduled turn keeps its partial text with message status
  `interrupted`; the job run records `failed`. The run summary is a redacted
  prefix of the response (`scheduler-worker.ts`).
- Each run creates a session with `purpose = 'scheduled'`. After the run, the
  worker purges the runtime and checkpoint thread of that session, and keeps
  the session and its messages. Retention deletes them later
  (`SCHEDULED_SESSION_RETENTION_DAYS`, [retention](data.md#retention-and-deletion)).

## Background workers

Every backend instance runs these; `app-bootstrap.ts` starts all but idle
teardown.

- `SCHEDULER_ENABLED=false` stops scheduled jobs.
- The scheduler worker still runs for the PII scan drain (on by default) and the
  retention jobs (`build-scheduler-worker.ts`).

| Worker | Code | Runs |
|---|---|---|
| Scheduler: jobs, PII scan jobs, session trash, scheduled session and project file retention | `services/scheduler-worker.ts`, `build-scheduler-worker.ts` | Every `SCHEDULER_POLL_INTERVAL_MS` |
| Mail outbox | `services/mail/mail-outbox-worker.ts` | Every `MAIL_POLL_INTERVAL_MS` (`MAIL_CLEANUP_INTERVAL_MS` with email off; code constants) |
| Expired session execution leases | `app-bootstrap.ts` | At start, then every `SESSION_EXECUTION_HEARTBEAT_MS` |
| Stale approvals | `services/runtime/stale-approval-sweeper.ts` | At start, then every `APPROVAL_REQUEST_TTL_MS` |
| Stale assistant messages | `services/runtime/stale-message-sweeper.ts` | At start, then at its stale deadline |
| Idle session runtimes | `services/runtime/idle-teardown.ts` | Per session, after `RUNTIME_IDLE_TIMEOUT_MS` |
| Expired in-memory rate-limit entries | `app-bootstrap.ts` (`limits.sweepExpired`) | Every `RATE_LIMIT_SWEEP_INTERVAL_MS` |

Add a worker:

1. Claim rows with `FOR UPDATE SKIP LOCKED`, so that replicas do not take the
   same row (example: `services/mail/mail-outbox-worker.ts`).
2. Give it `start(intervalMs)` with an `unref()` timer, `stop()`, and
   `drain(budgetMs)` that waits for the running pass.
3. Start it in `app-bootstrap.ts`, and stop and drain it in the `preClose` hook
   there, so a shutdown does not cut a pass.

Cross-tenant claims use `privilegedDb` ([database roles](../database-roles.md)).

