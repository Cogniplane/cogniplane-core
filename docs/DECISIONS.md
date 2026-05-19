# Architectural Decisions

The reasoning behind major architectural choices, after they're resolved. For operational mechanics, see `ARCHITECTURE.md` and the repo-root `CLAUDE.md`.

> **Codex framing.** Decisions 0–7 were originally written when Codex was the only runtime. The persistence, gateway pattern, capability policy, and approval flow apply unchanged to both providers. Decision 9 captures the choice to add Claude Code.
>
> **Capability profiles → tenant settings.** Decision 6 was originally implemented as admin-facing CRUD over named capability profiles. On 2026-04-15 that surface was replaced by a single per-tenant Agent Settings record (`tenant_settings`). The underlying policy model — versioned, compiled into the runtime manifest, controlling sandbox/network/tool/approval behavior — is unchanged. Only the admin surface collapsed.

---

## 0. Thick runtime vs. thin agent stack

**Decision:** Use Codex `app-server` as a thick runtime. Keep app-specific policy, auth, persistence, and tool routing in the backend.

**Why:** The framework should stop rebuilding agent runtime plumbing in application code (sessions, retries, planning loops, turn state, approvals, streaming) and reuse a stronger harness instead. ADK / LangGraph-style explicit graphs would require us to own most of that orchestration ourselves; direct LLM + tool calling reproduces all of it. The trade-off: more agentic-by-default behavior and protocol/version pinning become part of the platform.

---

## 1. MCP gateway pattern

**Decision:** MCP tools run as HTTP endpoints inside the Fastify backend. Codex calls them via HTTP MCP transport.

**Why:** Tools run outside the runtime sandbox so they have full network access. One process enforces auth, redaction, and audit. Tools share connection pools and caching. The alternative (stdio MCP child processes per runtime) inherits sandbox network restrictions, multiplies resource usage, duplicates audit logic, and complicates auth-context injection. The HTTP hop is acceptable given downstream service latency.

---

## 2. Thread persistence — Postgres as source of truth

**Decision:** Backend persists every message to the `messages` table as turns complete. Codex JSONL files exist only as an internal optimization for thread resume within Codex.

**Why:** Postgres gives queryable, auditable, crash-resilient storage that all backend features (replay, ratings, search, audit) need. Workspace cleanup or worker crash cannot lose history. If JSONL is lost, the backend reconstructs context by starting a new Codex thread with history injected — slightly more expensive but rare. The dual-source-of-truth alternative produces inevitable divergence under failure.

---

## 3. Default approval mode

**Decision:** Suggest mode by default. Read-only tools auto-approve at the MCP gateway. Per-skill / per-tool config is supported for tenants who want it.

**Why:** Suggest mode was the safest baseline for the initial release and satisfies enterprise compliance ("user approved every action"). Read-only auto-approval keeps friction low for the common SQL / retrieval / document-analysis tools. Full-auto was rejected as too unconstrained for enterprise audit; per-tool config (now via `tenant_settings`) covers the cases where admins want write tools to require gating.

---

## 4. PDF conversion visibility

**Decision:** Convert PDFs on demand per scoped turn. Don't persist derived text/image artifacts as separate session entries.

**Why:** The product UX should keep "one upload = one visible file." Persisting derived sidecar artifacts makes the artifact list noisier, easier to misunderstand, and pushes the product toward a document-pipeline architecture we don't want. The per-turn cost is acceptable.

**Guardrail:** Don't create user-visible `derived` artifacts for routine PDF question-answering. If internal derived artifacts ever return, they must be hidden from the session artifact list unless explicitly product-approved.

---

## 5. Session runtime — one process per session

**Decision:** Each active session gets its own `codex app-server` process and workspace. Created on demand, torn down after idle timeout.

**Why:** Simplest lifecycle, strongest isolation, fewest stale-state risks. Cold-start cost is acceptable for the current traffic shape; if it becomes a measured production issue, add a prewarm buffer later. A shared worker pool would multiply lifecycle complexity and create cross-session contamination risk before the baseline architecture is even proven.

---

## 6. Codex protocol — generated schemas from a pinned version

**Decision:** Pin a Codex version per deployment (`codex-release.json`). Generate TypeScript / JSON schemas from `codex app-server generate-ts` and `generate-json-schema`. Hand-written markdown contracts are not authoritative.

**Why:** Generated artifacts match the actual runtime exactly and give a concrete reference for tests and upgrade review. Hand-maintained contracts drift quickly. Inferring from runtime traces alone misses optional fields and edge cases. Protocol upgrades become explicit work items, which is the right trade.

---

## 7. Capability policy model

**Decision:** Versioned per-skill / per-tool capability profiles, compiled into the runtime manifest at session start. Profiles control sandbox roots, network egress class, approval mode, tool allowlist, and token-forwarding.

**Why:** Different skill families have genuinely different risk profiles; one global policy is too coarse for a reusable framework. Free-form per-session policy JSON is too easy to misconfigure and too hard to audit.

**Note:** The admin surface was originally multi-profile CRUD; on 2026-04-15 it collapsed to one Agent Settings record per tenant (`tenant_settings`). The underlying versioned policy model is unchanged.

---

## 8. User token handling for external MCP servers

**Decision:** Hybrid — first-party tools terminate inside the framework's managed broker; trusted external MCP servers may receive forwarded user tokens and own their own downstream auth.

**Why:** Forces the framework to understand only its own tools' auth, while still enabling enterprise extensibility. The framework owns session-ownership validation, audit, and token provenance. The "framework brokers everything" alternative limits extensibility and forces us to embed every business auth model. The "no token forwarding" alternative breaks real enterprise delegation use cases.

---

## 9. Skill authoring — structured sections compiled into the instructions field

**Decision:** The admin UI exposes structured sections (activation guidance, compatibility, tool constraints, workflow, references) and composes them into the persisted `instructions` body until full file-backed bundle persistence is ready.

**Why:** A single textarea encourages weak skill definitions and hides the distinctions that matter for Agent Skills compatibility. Waiting for full bundle persistence before improving the admin UX leaves the product underpowered for too long. The intermediate representation is acceptable; the persisted record is still one text blob, but the frontend is already shaped for the bundle world.

---

## 10. Second runtime provider — Claude Code behind the same `RuntimeAdapter`

**Decision:** Keep `RuntimeAdapter` as the contract. Add a Claude adapter that uses `@anthropic-ai/claude-agent-sdk` `query()` (in-process locally; in-sandbox harness in E2B). Route per tenant via `tenantSettings.runtimeProvider`. **Shipped 2026-04-17.**

**Why:** The contract (`createSession` / `runMessage` returning `AsyncIterable<RuntimeEvent>`) was already provider-neutral — adding Claude was an adapter-and-mapper job, not a platform rewrite. Tenants without an OpenAI contract get a path; single-vendor risk on pricing/availability/model-capability shrinks. Claude's extended-thinking is a real reasoning uplift.

A "unified provider-abstraction layer" was rejected: it re-introduces the "rebuild orchestration in app code" problem that motivated thick runtimes in the first place, and uniform event models lose the specific semantics each runtime offers best.

**Implementation rules that followed:**

- Provider-native execution paths stay separate. Don't force Claude into the Codex app-server process model.
- `RuntimeEvent` is the single internal type. Provider-specific event shapes never cross into the rest of the backend.
- Approval bridging is provider-specific (Claude uses `canUseTool`; Codex uses JSON-RPC request interception). Both land in the same `ApprovalStore` and emit the same frontend events.
- The MCP gateway, tool broker, audit, PII, and artifact pipelines are shared. No duplication of platform features.

See `guides/runtime-selection.md` for per-provider guidance.
