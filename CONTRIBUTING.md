# Contributing

Scope: how to propose a change, the Contributor License Agreement (CLA), and the
dependency license rule. Commands, tests and CI gates are in
[development](docs/development.md).

## Process

1. For anything beyond a small fix, open an issue first and agree on the
   approach. Typo, link and comment fixes can go straight to a pull request.
2. Keep one logical change per pull request.
3. Add or update tests for new behavior.
4. Run the checks and follow the conventions in
   [development](docs/development.md), and complete the pull request checklist.
   Squash work-in-progress commits.

## Contributor License Agreement

Every pull request needs a signed CLA ([CLA.md](CLA.md)). Cogniplane Core is
dual-licensed (AGPL-3.0 and commercial), so every contribution must be licensed
to the project under terms that allow both. You keep your copyright.

- On your first pull request, the CLA bot asks you to sign. Reply:
  `I have read the CLA Document and I hereby sign the CLA`.
- You sign once per GitHub account.
- For work on behalf of an employer, email `licensing@cogniplane.ai` first to
  arrange a corporate CLA.

## Dependency licenses

Every production dependency must have an AGPL-compatible license.
`pnpm license:check` runs in CI and fails on strong copyleft (GPL, AGPL),
source-available licenses and packages with no SPDX license; the exact lists
are in `scripts/license-check.ts`. Permissive licenses and LGPL are allowed. If no
alternative exists, open an issue: an exception needs legal review and an
allowlist entry in `scripts/license-check.ts`.

## Security issues

Do not open a public issue. Follow [SECURITY.md](SECURITY.md).

## Conduct and questions

[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) applies. For questions, open a GitHub
Discussion or email `hello@cogniplane.ai`.
