# Contributing to Cogniplane Core

Thanks for your interest in contributing. Cogniplane Core is an AGPL-3.0 + commercial dual-licensed project, and contributions of all sizes — bug reports, fixes, features, docs — are welcome.

## Before you write code

Please open an issue first for anything beyond a small fix. Tell us what you're trying to solve, and we'll either steer you to an existing issue or confirm the approach makes sense before you spend time on it.

For trivial changes (typo fixes, broken-link updates, comment-only patches), feel free to skip the issue and open a PR directly.

## Contributor License Agreement

**Every pull request requires a signed CLA.** This is non-negotiable — without it, we can't accept your contribution. Here's why and how:

### Why a CLA?

Cogniplane Core is dual-licensed. Most users get it under the AGPL-3.0; some commercial users can't comply with AGPL's network-service obligations and instead license it from us under a proprietary commercial license. For us to offer that commercial license, every line of code in the project must be licensed to us under terms that allow re-licensing.

Without a CLA, even a small typo fix from an external contributor would create a fragment of code that we couldn't include in the commercial license — and the dual-license model would break.

The CLA does **not** transfer copyright. You keep the copyright in your contribution. You grant us a perpetual, worldwide license to use it, including the right to license it under multiple terms (AGPL today, commercial alongside, anything else open-source we adopt later).

### How to sign

You don't need to do anything before opening a PR. Our CLA bot will handle it:

1. Open your first pull request.
2. The CLA bot will comment asking you to sign, with a link to [CLA.md](CLA.md).
3. Reply on the PR with: `I have read the CLA Document and I hereby sign the CLA`.
4. Your PR gets unblocked and reviewed.

You sign once per GitHub account. All future PRs from the same account are pre-cleared.

### Contributing on behalf of an employer

If your contribution is on behalf of an employer or organization (anything beyond a personal hobby PR), email `licensing@cogniplane.ai` first. We'll arrange a Corporate CLA. This protects both you and your employer from later disputes about who owns what.

### Read the full CLA

The full text is in [CLA.md](CLA.md) at the root of this repository. It's adapted from the Apache Software Foundation's standard ICLA with the dual-licensing right made explicit.

## Code standards

- **Lint, type-check, and test before pushing.** The repo's pre-push hook runs these — please don't bypass it.
- **One logical change per PR.** A "fix the bug + refactor everything around it" PR is much harder to review than two PRs.
- **Tests for new behavior.** Backend and frontend use Vitest. See [README.md](README.md) for how to run a single test.
- **Keep commits clean.** Squash work-in-progress commits before opening the PR. We don't enforce a strict commit-message format, but please make the subject line readable.

## Dependency licenses

Cogniplane Core's dual-license model (AGPL-3.0 + commercial) only holds when every transitive production dependency carries an AGPL-compatible license. CI runs `pnpm license:check` on every PR and will fail the build if a production dependency carries any of the following:

- **Strong copyleft**: GPL-1.0/2.0/3.0 (any variant), AGPL-1.0/3.0 (any variant)
- **Source-available**: SSPL-1.0, BUSL-1.1, Elastic-2.0, Commons-Clause
- **Unknown**: any package with no detectable SPDX license declaration

Permissive licenses (MIT, Apache-2.0, BSD-2-Clause / BSD-3-Clause, ISC, BlueOak-1.0.0, LGPL-2.1 / LGPL-3.0) are fine. Dual-licensed packages (e.g. `(MIT OR GPL-3.0-or-later)`) are also fine — the consumer picks the permissive branch.

If your change adds a forbidden dependency, the right move is almost always to find an alternative. In rare cases where there isn't one (e.g. a vendor SDK), open an issue and tag the maintainers — the call requires written legal review and an explicit allowlist entry in `scripts/license-check.ts`.

You can run the check locally before pushing:

```bash
pnpm license:check
```

## Reporting security issues

**Do not open a public issue for security vulnerabilities.** See [SECURITY.md](SECURITY.md) for the responsible disclosure process.

## Code of Conduct

Participation in this project is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Be kind. Disagree about ideas, not people.

## Questions

Open a GitHub Discussion or email `hello@cogniplane.ai`. We're a small team and may take a few days to reply, but we read everything.
