# Runtime Selection

Cogniplane supports two runtime providers. This document explains why both exist, when to pick which, and what the trade-offs are.

## The Core Bet

Cogniplane is built on the premise that a **thick agent runtime** is better than rebuilding orchestration in application code. Multi-step planning, tool-use retries, approval handling, turn lifecycle, and richer streaming are all things a mature runtime gives you for free.

That bet is provider-agnostic. What matters is that the runtime carries enough intelligence to reduce app-layer orchestration, not which vendor supplies it.

## Providers Supported

### Codex (`codex app-server`)

- JSON-RPC 2.0 over stdio, running inside a per-session E2B sandbox
- Pinned via `apps/backend/src/codex-release.json`
- Schema artifacts generated from the pinned binary are the protocol source of truth
- Strong coding-agent heritage; sandbox control, shell/file/git capabilities gated by policy
- Default for most tenants

### Claude Code

- Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) driven via `query()` inside the per-session E2B sandbox (the `sandbox-agent.mjs` harness)
- Requires `ANTHROPIC_API_KEY` (platform-level or per-tenant)
- Approvals bridged via the SDK's `canUseTool` callback and deferred promises
- Strong reasoning and planning streaming; first-class extended thinking events

## How Selection Works

Per-tenant via `tenantSettings.runtimeProvider` (`"codex"` or `"claude-code"`). The `RuntimeAdapter` registry resolves the correct adapter at session start. The message route is runtime-neutral.

If `ANTHROPIC_API_KEY` is unset, the Claude adapter is not registered and Codex is the only option. Similarly, a tenant cannot be switched to a provider the deployment doesn't have credentials for.

## When to Pick Which

| Need | Recommendation |
|---|---|
| Default, broad coverage | Codex |
| Deep reasoning / extended thinking visibility | Claude |
| Coding-heavy workloads (shell, git, file edits) | Codex |
| Workloads that benefit from plan/text streaming the user watches live | Claude |
| E2B sandboxing with the smaller template image | Codex (separate templates exist per provider) |
| Tenant with only an Anthropic contract | Claude |
| Tenant with only an OpenAI contract | Codex |

This is guidance, not policy. The runtime is a per-tenant setting that can be changed.

## What Stays the Same Across Runtimes

- The MCP gateway, tool broker, approvals, and audit pipeline are identical.
- Skills, capability settings, PII posture, and artifact sync behave the same from a tenant admin's perspective.
- The frontend renders one conversation shape; the event mapper normalizes provider-native events into `RuntimeEvent` before anything else sees them.
- Postgres remains the source of truth for message history. Neither runtime's native rollout / session file is used for user-facing features.

## What Does Not Apply

This project does **not** use:

- `codex-sdk` — only `codex app-server`
- A generic "LangGraph / LangChain / ADK" graph orchestrator — the runtime is the orchestrator
- A thin LLM-plus-tool-loop built in application code — the whole point is to avoid that

## What Still Stays in the Backend

The choice of a thick runtime does not mean it owns auth or data. The backend always owns:

- session ownership and tenant scoping
- user/tenant authentication
- persistence (messages, artifacts, audit)
- tool context resolution and credential injection
- approval state machine
- PII detection and transform pipeline
- cost attribution and quotas

The runtime is the execution engine. Everything about who can do what, and what gets recorded, is backend policy.

## Success Criteria

The two-runtime investment is successful if tenants can switch providers without re-authoring skills, capability settings, or approval workflows — and if both providers benefit equally from platform features like PII protection, scheduled jobs, and GitHub managed tools.

If a feature only works on one provider for extended periods, that is a signal to either normalize it or admit the feature is provider-specific in product surfaces.
