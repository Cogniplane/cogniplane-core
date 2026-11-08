# Architecture decisions

Scope: why the system has its current shape. Each record states the decision,
the reason, and the rules that follow. Superseded records keep one line so the
history stays clear. Numbers are stable ids; a missing number was removed.
Current behavior is in the [architecture](architecture/overview.md) documents.

## Active

### D1. Backend owns policy; the runtime is a library

The backend owns auth, persistence, tool routing, policy and audit. The agent
loop (planning, subagents, interrupts, checkpoints) comes from an agent runtime
library instead of app code. Since D9 that runtime is Deep Agents in-process.

### D2. MCP gateway inside the backend

Tools run as HTTP MCP endpoints in the Fastify backend (`/mcp/:serverId`), not
as stdio child processes. One process enforces auth, redaction and audit, and
tools share connection pools.

### D3. PostgreSQL is the source of truth

History (`messages`) and agent state (checkpoints) both live in PostgreSQL, so a
lost workspace or process cannot lose a conversation. Sandboxes and caches are
disposable: a file that exists only in a sandbox workspace, and was not saved as
an artifact, is lost when the sandbox expires.

### D4. Approval policy is a tenant choice with fixed exceptions

Tenants differ in how much review they want, so the native approval policy is a
tenant setting. Controls that protect other people or the user's own data
(Policy Center enforcement, D8, and memory consent) do not depend on it. Current
rules: [approvals](architecture/approvals.md).

### D6. Immutable skill revisions; activation is release and rollback

Immutable revisions keep exact review history, make release an explicit state
change, give runtimes and audit stable ids, and make rollback a normal
activation. The cost is a two-table model.

### D7. Skills are a read-only file library, not prompt text

Serving skills as files that the model reads on demand keeps the prompt small
and stable as tenants add skills, and keeps skill files out of the sandbox.

### D8. Policy Center: small rule model, tenant-level enforcement

Operators must reason about rules under incident pressure. Connector, role, PII
and per-rule enforcement concepts added state faster than control, so they were
removed. One tenant switch (monitor or enforce) lets admins test a whole rule
set on real traffic, then enforce it at once. Policy Center approvals use the
native graph interrupt, not a held HTTP response.

### D9. Deep Agents is the only runtime

The Codex and Claude Code runtimes were retired. One runtime removed duplicate
event mappers, approval bridges and sandbox images. Model choice moved from the
runtime to the model layer (`initChatModel`). Rules: `RuntimeAdapter` stays the
contract; the E2B template holds no agent code.

### D10. AG-UI from the in-process graph

The browser and scheduler consume AG-UI events mapped from the embedded graph.
The standard LangGraph bridge needs a LangGraph API server, which would move the
checkpointer and gateway integration; it was rejected. Current contract:
[runtime](architecture/runtime.md#streaming-contract) and [MCP
Apps](architecture/mcp-apps.md#resource-contract).

### D11. E2B runs code only

E2B is the per-session execution environment; the agent loop and model
credentials stay in the backend, so a sandbox holds no secrets. Another sandbox
provider must keep per-session workspace isolation.

### D12. Two tenant isolation layers

Every tenant query has an explicit `tenant_id` predicate and also runs under
RLS, so one missing layer does not expose another tenant's rows. Mechanism:
[data](architecture/data.md#tenant-isolation).

### D13. Local accounts beside WorkOS; Redis with `jwt`

Tenants without an identity provider need sign-in, so local accounts exist next
to WorkOS, with one sign-in type per tenant. Revocable refresh tokens, sign-in
flows and throttles must be shared by all replicas, so `jwt` mode requires
Redis.

### D14. Step-up and owner notices for sensitive changes

A stolen admin token must not make a lasting change unseen. Step-up blocks it
for local sessions. Cogniplane cannot ask WorkOS for a fresh proof, so WorkOS
sessions are not blocked and owner notices make the change visible instead.
Rules and limits: [sensitive changes](architecture/sensitive-changes.md).

### D15. Model spending is reserved before calls

Provider invoices arrive late and failed calls do not always report usage, so
admission reserves an estimate per turn and unknown usage blocks new turns until
an admin reconciles it. Rules: [model spending](architecture/model-spending.md).

### D16. PII checks fail closed on provider errors

When a tenant asks to block or transform personal data, a provider error must
not let that data through, so the check fails in those modes. Behavior per mode:
[PII](architecture/pii.md).

## Superseded

| Record | Replaced by |
|---|---|
| Codex `app-server` as runtime; one runtime process per session | D9 |
| Per-skill capability profiles | `tenant_settings` (2026-04), then D8 |
| Forwarding user tokens to external MCP servers | Removed 2026-09: service credentials, member credentials, signed proxy headers |
| Claude Code as a second runtime | D9 |
| Bundles installed into the runtime workspace; Codex-verified installs | D7 |
