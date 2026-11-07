# Cogniplane Core

[![CI](https://github.com/Cogniplane/cogniplane-core/actions/workflows/ci.yml/badge.svg)](https://github.com/Cogniplane/cogniplane-core/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Commercial license](https://img.shields.io/badge/commercial%20license-available-green.svg)](COMMERCIAL.md)

Multi-tenant platform for governed AI agents in the browser: a chat and project
workspace, managed integrations, human approvals, policy rules and audit logs.

- Agent loop: LangChain [Deep
  Agents](https://reference.langchain.com/javascript/deepagents) in the Fastify
  backend, with durable PostgreSQL checkpoints.
- Code execution: a per-session E2B sandbox with default-deny network.
- Tools: an MCP gateway that injects credentials; the model never sees them.
- Governance: approvals, Policy Center rules, step-up for sensitive changes,
  PII detection, model-spending limits.
- Isolation: PostgreSQL row-level security per tenant.
- Sign-in: WorkOS SSO, or local accounts with TOTP and passkeys.
- Models from several [providers](docs/architecture/models.md#model-providers),
  with platform or tenant keys.

## Quickstart

You need Node.js, Docker, an E2B account and one model provider key. Follow
[getting started](docs/getting-started.md); `make dev` then serves
`http://localhost:3000`.

## Documentation

Start with [getting started](docs/getting-started.md) or the [architecture
overview](docs/architecture/overview.md). The map of all documents by task is in
[CLAUDE.md](CLAUDE.md#documentation-map).

## License

Dual license:

- [AGPL-3.0](LICENSE): use, modify and self-host. If you offer it as a network
  service, you must publish your changes under the AGPL.
- [Commercial license](COMMERCIAL.md) for other terms: `licensing@cogniplane.ai`.

Dependency licenses: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
[Cogniplane Cloud](https://cogniplane.ai/oss) is a hosted version of this code.

This repository holds the complete product, including the SharePoint overlay
under `private/` (AGPL; the `private` and `@cogniplane-private/*` names are
historical). Deployment credentials, infrastructure operations, the website
and business documents are elsewhere.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md); a signed CLA is required. Report
vulnerabilities as described in [SECURITY.md](SECURITY.md).
