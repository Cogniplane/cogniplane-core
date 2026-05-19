# Commercial License

Cogniplane Core is dual-licensed. The default license is the GNU Affero General Public License v3.0 — see [LICENSE](LICENSE). This document describes when you might need the alternative commercial license and how to get one.

## You probably don't need a commercial license

Most uses of Cogniplane Core are fine under the AGPL-3.0:

- Running it internally at your company, including for paying employees and contractors.
- Modifying it for internal use, even substantially.
- Building integrations, skills, MCP servers, or downstream tools that talk to Cogniplane Core over its public APIs.
- Self-hosting it on your own infrastructure for your own organization's use.

The AGPL only kicks in as a constraint when you (a) distribute the software in a product, or (b) offer it as a network service to third parties. In both cases the AGPL requires you to release your modifications under the AGPL too. If you're comfortable doing that, you don't need a commercial license.

## When you do need a commercial license

A commercial license is the right path if any of these apply:

- **You're embedding Cogniplane Core in a proprietary product you distribute** to customers and you don't want to release your modifications under the AGPL.
- **You're offering Cogniplane Core (or a derivative) as a hosted service to third parties** and you don't want the AGPL §13 network-use clause to require you to release your modifications.
- **Your legal team's policy forbids AGPL-licensed software** even for purely internal use. This is real — some Fortune 500s and regulated industries treat AGPL as a no-go regardless of how it's used.
- **You need contractual terms the AGPL doesn't provide** — warranty, indemnification, defined support response times, a written contract for procurement.

## What the commercial license grants

- The same code, under proprietary license terms negotiated for your use case.
- No AGPL copyleft obligation on your modifications.
- A signed written agreement you can hand to procurement and legal.
- Optionally: support terms, indemnification, and named-contact escalation paths.

The code itself is identical — switching to the commercial license doesn't fork your codebase or change which version of Cogniplane Core you run. You continue to receive AGPL OSS releases on the public repo; the commercial license simply gives you alternate terms for using them.

## Third-party terms that flow through

Cogniplane Core bundles the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) provided by Anthropic PBC. Our commercial license governs Cogniplane's code only; the Claude Agent SDK is governed by **Anthropic's [Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms)**. Customer's use of the Claude runtime is additionally subject to those upstream terms. Customer is responsible for maintaining its own Anthropic account and API key — consumer subscriptions (Free/Pro/Max) are not supported by the Agent SDK.

The same flow-through applies to the other third-party components Cogniplane Core depends on (Codex CLI under Apache-2.0, sharp-libvips under LGPL-3.0, and the rest of the dependency tree). The commercial license does not relicense those components; their upstream terms continue to apply. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the full attribution and license inventory.

## How to get one

Email **`licensing@cogniplane.ai`** with:

- Company name and country.
- A short description of your intended use case (one paragraph is fine — what you're building, who the end users are, whether it's distributed or hosted).
- Approximate deployment scale (rough concurrent-sandbox count or user count, if you know it).

We'll respond within a few business days with proposed terms. Pricing depends on use case — there's no published price list. Most commercial deals are annual, with a setup discussion to make sure the license actually covers what you need.

## Or use Cogniplane Cloud

If self-hosting isn't a hard requirement and you're commercial-license-curious mostly because you'd rather not run the infrastructure, [Cogniplane Cloud](https://cogniplane.ai/oss) is the hosted version of the same code, on managed infrastructure, with SSO and managed integrations included. Many readers who land here actually want Cloud and didn't realize it existed.

## Not legal advice

This page summarizes the commercial-licensing offer in plain language. It is not legal advice and does not by itself grant any license. The binding terms are in the written agreement we sign with you.
