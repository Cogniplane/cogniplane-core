# Approvals

Scope: native and Policy Center approvals, approval cards and the approval
proof. The gateway is in [tools](tools.md).

Native approvals and Policy Center approvals use one checkpointed graph
interrupt, one `approvals` row, one AG-UI event and one decision route.

- `resolveTurnApprovalSettings` (`runtime-contracts.ts`) decides the gate from
  `tenant_settings.approval_policy` and, in a project chat, the project's
  `approval_mode`:
  - `organization_default` and `automatic`: the tenant policy; `never` turns the
    gate off. `automatic` cannot weaken the tenant policy.
  - `manual`: the gate is on and read-only auto-approve is off, even when the
    tenant policy is `never`.
- The gate builds the `interruptOn` map in `deep-agents-graph.ts`. It covers:
  - all gateway tools, and the deepagents built-ins in `MUTATING_BUILTIN_TOOLS`;
  - the built-ins in `READ_ONLY_BUILTIN_TOOLS`, when
    `auto_approve_read_only_tools` is off.
- With `auto_approve_read_only_tools` on, catalog tools marked read-only skip
  approval. A proxy server's `readOnlyHint` does not count for this switch.
- The interrupt pauses the graph before the tool runs. The adapter saves an
  `approvals` row, emits the `CUSTOM` event `approval_required`, and resumes the
  graph with a `Command` after `POST /approvals/:approvalId/decision` (`{
  decision: "approve" | "reject", rememberForTurn? }`).
- Resume values are keyed by interrupt id, so parallel subagent approvals stay
  apart.
- Expiry: `APPROVAL_REQUEST_TTL_MS`. On expiry the row becomes `expired`, the
  audit event `approval.expired` is written, a `runtime_notice` event
  (`approval-expired:<approvalId>`) goes to the turn, and the graph resumes with
  a reject. `stale-approval-sweeper.ts` expires rows after a process stops.
- A declined, expired or refused call returns a `declined` tool result. When one
  call of a step is not approved, the other calls of that step do not run.

## Tool calls and approval cards

- `stream-events-to-agui.ts` gives each main-agent tool call a server id at
  `on_chat_model_end`. Models repeat call ids, so a model call id is never an
  identity. Cards, results (`tool_result_id`) and approvals use the server id.
- An approval links to a card only through `approvals.tool_call_id` (migration
  `085`), set from the HITL description of a main-agent interrupt. Delegated
  (subagent) interrupts get no link. Never link by `itemId`, tool name,
  arguments or position.
- Approval reads return public fields only, never proofs, payloads or runtime
  identity.
- The decision route returns 404 `approval_not_found` when no open approval
  matches the caller. In the browser (`use-agui-custom-events.ts`), a failed
  decision shows an error notice and enables the controls again. After a 404,
  409 or 410, the browser reads the pending approvals again and shows that list.
- Tests: `deep-agents-graph.test.ts` pins the SDK behavior;
  `deep-agents-approval-cards.test.ts` runs the real graph.

## Policy Center approval proof

- On an interactive turn, a `require_approval` match uses the same interrupt.
  The runtime keeps a proof (random approval id) in memory keyed by tool-call
  id. The proof never enters tool arguments, and a rebuilt runtime does not
  restore it.
- After approval, the runtime sends `policyApprovalId` in `_meta`. The gateway
  accepts it only when the row matches session, user, tool, server, tool context
  and the canonical argument hash (`policyArgsHash`, which ignores the transport
  keys at the argument root only).
- The gateway claims the approval once (`consumed_at`) before dispatch. A
  missing, rejected, expired, mismatched or used proof returns
  `PolicyBlockedError` (`-32004`).
- Managed tools with `requiresUserApproval` use the same proof under stricter
  rules: [memory consent](memory.md).
