# Working in Cogniplane Core

Scope: rules and the documentation map for coding agents in this repository.

Cogniplane Core is a multi-tenant browser workspace for governed AI agents:
Fastify backend, Next.js frontend, shared Zod contracts. Deep Agents runs the
agent loop in the backend; E2B runs shell and file tools.

## Delivery

- Carry a change through implementation and verification. Trace the route,
  runtime, persistence and frontend paths it touches. Keep small changes small.
  Preserve existing work and security boundaries.
- Do not commit, push, publish, merge or deploy without explicit user
  authorization. When authorized: Conventional Commits, related changes batched,
  required checks run, hooks never bypassed. No AI attribution in commits or PRs.
  Process: [CONTRIBUTING](CONTRIBUTING.md).
- Report what changed, which checks ran, and what stays unverified. Passing unit
  mocks do not prove a live provider call or a database policy.

## Rules

Short forms of the most-used rules; each links to its owner.

- Run tenant queries in `withTenantScope` as `app_user`
  ([tenant data invariant](docs/security.md#tenant-data)).
- Never give credentials to the model or the sandbox
  ([credentials invariant](docs/security.md#credentials)).
- Build public errors with `apiError`; never expose SDK or database errors
  ([public errors invariant](docs/security.md#public-errors)).
- Never edit an applied migration; add the next numbered file
  ([conventions](docs/development.md#conventions)).
- Before other backend changes, read all
  [security invariants](docs/security.md#invariants).

## Verify

Run `make test` and `make lint` for every change. Also run:

- `make test-integration` after a change to SQL, RLS, a migration or a store;
- `pnpm --filter @cogniplane/frontend cf:build` after a frontend build or
  configuration change;
- `pnpm --filter @cogniplane/shared-types build` before you test consumers of an
  edited contract;
- the [configuration](docs/configuration.md) and [routes](docs/routes.md)
  generators after a change to `apps/backend/src/config.ts` or to a route.

Other commands, test rules and CI gates: [development](docs/development.md).

## Documentation map

Read the document for your task. Each fact has one owner; update that owner and
link to it. Look up capitalized names in [configuration](docs/configuration.md)
(backend), [frontend](docs/architecture/frontend.md#builds-and-variables) or
[connectors](docs/connectors.md) (overlay); any other is a code constant in the
cited file.

| Task | Read |
|---|---|
| Find code; system shape; turn flow; terms | [architecture overview](docs/architecture/overview.md) |
| Agent graph, session types, turns, reconnect and stop, streaming contract, scheduled jobs and workers | [runtime](docs/architecture/runtime.md) |
| Model providers and keys, custom models, [add a model](docs/architecture/models.md#add-a-model-or-provider), utility model | [models](docs/architecture/models.md) |
| Model cost limits | [model spending](docs/architecture/model-spending.md) |
| E2B sandbox, workspace, template, sandbox network | [sandbox](docs/architecture/sandbox.md) |
| MCP gateway, managed and proxy tools, member credentials, personal connections | [tools](docs/architecture/tools.md) ([add a core managed tool](docs/architecture/tools.md#add-a-core-managed-tool)) |
| Native approvals, approval cards, Policy Center approval proof | [approvals](docs/architecture/approvals.md) |
| Tenant tool rules (allow, block, require approval) | [Policy Center](docs/architecture/policy-center.md) |
| Auth modes, tokens, request authentication, roles, WorkOS sign-in | [auth](docs/architecture/auth.md) |
| Local accounts, revocation, MFA, passkeys, operator commands | [local accounts](docs/architecture/local-accounts.md) |
| SMTP, account emails, email outbox | [email](docs/architecture/email.md) |
| Step-up, data routes, weaker controls, skill releases, owner notices | [sensitive changes](docs/architecture/sensitive-changes.md) |
| RLS, [add a tenant table](docs/architecture/data.md#add-a-tenant-table), tenant settings, Redis, retention, audit, usage and feedback, rate limits | [data](docs/architecture/data.md) |
| Projects, artifacts, uploads, downloads, workspace sync | [projects and files](docs/architecture/projects-and-files.md) |
| PII detection, scan jobs, PII policy | [PII protection](docs/architecture/pii.md) |
| Skills, skill bundles, capability resolution | [skills](docs/architecture/skills.md) |
| Long-term memory, memory consent | [memory](docs/architecture/memory.md) |
| Frontend routes, providers, API clients, builds, [add a page](docs/architecture/frontend.md#add-a-page) | [frontend](docs/architecture/frontend.md) |
| Chat host, `render_ui`, side panel, tool cards | [chat UI](docs/architecture/chat-ui.md) |
| Widgets, `render_interactive_ui`, MCP App sandbox | [MCP Apps](docs/architecture/mcp-apps.md) |
| Commands, tests, CI, [new HTTP route and shared contracts](docs/development.md#conventions), deferred SQL, releases | [development](docs/development.md) |
| New connector or overlay | [overlays](docs/overlays.md) |
| Set up GitHub, Notion, Jira, Microsoft 365 or a proxy MCP server; [logos](apps/frontend/public/integrations/README.md) | [connectors](docs/connectors.md) |
| Upstream MCP server verifying gateway requests | [MCP proxy signature](docs/mcp-proxy-signature.md) |
| Security invariants, secrets, outbound URL (SSRF) rules, headers; review | [security model](docs/security.md), [threat index](docs/threat-index.md) |
| Environment variables; HTTP routes (both generated) | [configuration](docs/configuration.md), [routes](docs/routes.md) |
| Database roles and grants | [database roles](docs/database-roles.md) |
| Local setup; Compose stack; production | [getting started](docs/getting-started.md), [Docker deploy](docs/docker-deploy.md), [self-hosting](docs/self-hosting.md) |
| Upgrade, scaling, secrets, backups, audit retention, tenant deletion, monitoring | [operations](docs/operations.md) |
| Why the design is this way | [decisions](docs/decisions.md) |
| Contribution process, CLA, licenses; vulnerability reports | [CONTRIBUTING](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) |
| UI design; Next.js version notes | [PRODUCT](apps/frontend/PRODUCT.md), [DESIGN](apps/frontend/DESIGN.md), [frontend AGENTS](apps/frontend/AGENTS.md) |
