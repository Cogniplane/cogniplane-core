# Security policy

Scope: how to report a vulnerability. The security design is in
[docs/security.md](docs/security.md).

## Report a vulnerability

Do not open a public GitHub issue. Email `security@cogniplane.ai` with:

- The affected component (file, route or feature) and a description.
- Steps to reproduce.
- The impact on confidentiality, integrity or availability.
- Optional: a proposed fix.

We acknowledge a report within 5 business days and agree a disclosure timeline
with you. We aim to fix most issues within 30 days. If you get no
acknowledgement in 5 business days, send the report again.

For the hosted product, Cogniplane Cloud, use the same address and name the
hosted product in the report.

## Scope

In scope: the code in this repository (backend, frontend, shared contracts,
sandbox template), and dependency vulnerabilities that this code exposes.

Not in scope:

- Dependency vulnerabilities on code paths that this code never calls.
- Issues that need tenant administrator access first, unless they let an admin
  reach another tenant or gain owner rights (those are in scope).
- Volumetric denial of service.

## Credit

With your permission, we credit reporters of confirmed issues in release notes.
There is no paid bug bounty.
