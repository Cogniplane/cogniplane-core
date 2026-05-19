# Security Policy

Cogniplane Core handles authentication, multi-tenant data, and sandboxed code execution. We take security seriously and welcome reports from researchers and users.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Email **`security@cogniplane.ai`** with:

- A description of the vulnerability and the affected component (which file, route, or feature).
- Steps to reproduce.
- Your assessment of impact (confidentiality, integrity, availability).
- Optionally, a proposed fix.

We will acknowledge receipt within **5 business days** and work with you on a coordinated disclosure timeline. For most issues, we aim to ship a fix within 30 days of the initial report.

If you do not receive an acknowledgement within 5 business days, please follow up — the original email may have been misclassified.

## Scope

In scope:

- The Cogniplane Core codebase in this repository (backend, frontend, sandbox harness, sync tooling).
- Vulnerabilities in dependencies that are exposed by how Cogniplane Core uses them.

Out of scope (please do not report):

- Vulnerabilities in `Cogniplane Cloud` (the hosted SaaS) — report those to the same email but mention the hosted product explicitly.
- Vulnerabilities in upstream dependencies that we don't expose (e.g., theoretical CVEs in libraries we never invoke from a network-reachable code path).
- Issues that require an attacker to already have administrator access to a Cogniplane tenant.
- Denial-of-service via volumetric attacks (this is a deployment-side concern, not a code defect).

## Acknowledgements

With your permission, we'll list reporters of confirmed vulnerabilities in release notes and on the project's security page. If you prefer to remain anonymous, we will respect that.

## Bounty

Cogniplane Core does not currently run a paid bug bounty. We may add one in the future as the project grows. In the meantime, we appreciate every report and will credit reporters in releases.
