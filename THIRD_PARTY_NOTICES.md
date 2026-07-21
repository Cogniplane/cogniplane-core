# Third-Party Notices

Cogniplane Core is distributed under the [GNU AGPL-3.0](LICENSE) (or, for commercial licensees, under terms negotiated separately — see [COMMERCIAL.md](COMMERCIAL.md)). It depends on third-party software released under a variety of licenses. This file is the consolidated attribution and license notice for those components.

The list below is generated from `pnpm licenses list --prod` on the published lockfile. The authoritative source for what's actually installed at any given commit is `pnpm-lock.yaml` plus each package's own `LICENSE` file in `node_modules/`. This file describes the obligations Cogniplane Core inherits when redistributing the dependency tree.

## Summary of license categories

| License | Count | Notes |
|---|---:|---|
| MIT | 470 | Permissive; attribution preserved in upstream `LICENSE` files |
| Apache-2.0 | 48 | Permissive with patent grant; see explicit list below |
| ISC | 34 | Permissive; equivalent to simplified BSD |
| BlueOak-1.0.0 | 11 | Permissive (Blue Oak Council model license) |
| BSD-3-Clause | 8 | Permissive |
| MPL-2.0 | 2 | File-level weak copyleft, used unmodified (`lightningcss` + native binary) |
| BSD-2-Clause | 1 | Permissive |
| 0BSD | 1 | Public-domain-equivalent |
| CC0-1.0 | 1 | Public-domain-equivalent |
| Unlicense | 1 | Public-domain-equivalent (`fast-sha256`) |
| MIT AND ISC | 1 | Both permissive licenses apply (`victory-vendor`) |
| Apache-2.0 AND BSD-3-Clause | 1 | Both apply (`@bufbuild/protobuf`) |
| MIT AND Zlib | 1 | Both apply (`pako`) |
| MIT OR GPL-3.0-or-later | 1 | Cogniplane elects MIT (`jszip`) |
| LGPL-3.0-or-later | 1 | Native binary, dynamic-link only (`@img/sharp-libvips-linux-x64`) |
| CC-BY-4.0 | 1 | Attribution-required (`caniuse-lite`, devtime data) |

In addition, the E2B sandbox template (`docker/template.ts`) installs only operating-system packages (Debian, via `apt-get`) and a pinned set of Python libraries (pandas, openpyxl, matplotlib, jinja2) at template-build time. These are not in `pnpm-lock.yaml` because they're installed inside the sandbox image, not as workspace dependencies; each is governed by its own upstream open-source license. No agent CLIs, SDKs, or proprietary software is installed in the template.

## Apache License, Version 2.0

The following dependencies are licensed under the Apache License, Version 2.0. Cogniplane Core preserves each upstream package's `LICENSE` file as installed by pnpm. None of the listed upstream packages ship a `NOTICE` file in the published distribution; if a future upstream version begins shipping one, the obligation to preserve and propagate it is inherited automatically through `node_modules/`.

The full text of Apache-2.0 is available at <https://www.apache.org/licenses/LICENSE-2.0>.

Apache-2.0 dependencies (workspace `--prod`):

```
@aws-crypto/crc32                        @aws-sdk/types
@aws-crypto/crc32c                       @aws-sdk/util-locate-window
@aws-crypto/sha1-browser                 @aws-sdk/xml-builder
@aws-crypto/sha256-browser               @aws/lambda-invoke-store
@aws-crypto/sha256-js                    @connectrpc/connect
@aws-crypto/supports-web-crypto          @connectrpc/connect-web
@aws-crypto/util                         @img/sharp-linux-x64
@aws-sdk/checksums                       @smithy/core
@aws-sdk/client-s3                       @smithy/credential-provider-imds
@aws-sdk/core                            @smithy/fetch-http-handler
@aws-sdk/credential-provider-env         @smithy/is-array-buffer
@aws-sdk/credential-provider-http        @smithy/node-http-handler
@aws-sdk/credential-provider-ini         @smithy/signature-v4
@aws-sdk/credential-provider-login       @smithy/types
@aws-sdk/credential-provider-node        @smithy/util-buffer-from
@aws-sdk/credential-provider-process     @smithy/util-utf8
@aws-sdk/credential-provider-sso         @swc/helpers
@aws-sdk/credential-provider-web-identity  baseline-browser-mapping
@aws-sdk/lib-storage                     class-variance-authority
@aws-sdk/middleware-flexible-checksums   cluster-key-slot
@aws-sdk/middleware-sdk-s3               denque
@aws-sdk/nested-clients                  detect-libc
@aws-sdk/signature-v4-multi-region       openai
@aws-sdk/token-providers                 sharp
```

## MPL-2.0: `lightningcss`

The frontend build toolchain depends on `lightningcss` and its prebuilt native binary `lightningcss-linux-x64-gnu`, both licensed under the **Mozilla Public License 2.0**. MPL-2.0 is a file-level weak copyleft: its obligations attach to the MPL-licensed source files themselves, not to the larger work. Cogniplane Core uses lightningcss unmodified as a build-time CSS transformer; no MPL-licensed file is modified or redistributed in changed form. Upstream: <https://github.com/parcel-bundler/lightningcss>. MPL-2.0 text: <https://www.mozilla.org/en-US/MPL/2.0/>.

## Dual Apache-2.0 AND BSD-3-Clause: `@bufbuild/protobuf`

Both licenses apply concurrently. Cogniplane Core complies with the cumulative obligations of both: attribution (BSD-3-Clause) and patent grant + Apache-2.0 §4 attribution. Upstream: <https://github.com/bufbuild/protobuf-es>.

## Dual MIT AND Zlib: `pako`

Both licenses apply concurrently. Cogniplane Core complies with both. Upstream: <https://github.com/nodeca/pako>.

## Dual-license election: `jszip` (MIT OR GPL-3.0-or-later)

`jszip` is offered under MIT or GPL-3.0-or-later at the redistributor's election. **Cogniplane Core elects the MIT license.** Upstream: <https://github.com/Stuk/jszip>.

## LGPL-3.0-or-later: `@img/sharp-libvips-linux-x64`

The `sharp` image-processing library (Apache-2.0) ships prebuilt `libvips` and its dependencies as a separate native package, `@img/sharp-libvips-linux-x64`, licensed under **LGPL-3.0-or-later**.

Cogniplane Core does not statically link or modify libvips. The `sharp` Node.js wrapper loads the prebuilt native library at runtime as a dynamic-link dependency (`require()` against the `@img/sharp-libvips-linux-x64` binary). This is the standard LGPL §6 dynamic-link relationship — users retain the right to replace the libvips library with a modified version of their own.

- Source for `sharp`: <https://github.com/lovell/sharp>
- Source for `libvips`: <https://github.com/libvips/libvips>
- LGPL-3.0 text: <https://www.gnu.org/licenses/lgpl-3.0.html>

To replace the libvips binary in a Cogniplane Core deployment, build your own `@img/sharp-libvips-linux-x64` package from libvips source and override the dependency resolution in your install (e.g., via a pnpm `overrides` entry).

## CC-BY-4.0: `caniuse-lite`

The `caniuse-lite` package (used by browserslist for browser-compatibility data) is licensed under **CC-BY-4.0**, which requires attribution. The data is authored and maintained by the `caniuse.com` project.

Attribution: caniuse-lite, © Ben Briggs and contributors, distributed under [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). Source: <https://github.com/browserslist/caniuse-lite>.

`caniuse-lite` is a build-time dependency. Its data is not redistributed by Cogniplane Core's runtime artifacts; it informs which browser polyfills the frontend bundler emits.

## Permissive bulk: MIT, ISC, BlueOak-1.0.0, BSD-2/3-Clause, 0BSD, CC0-1.0, Unlicense

The remaining ~530 production dependencies are under permissive or public-domain-equivalent licenses (MIT, ISC, BlueOak-1.0.0, BSD-2-Clause, BSD-3-Clause, 0BSD, CC0-1.0, Unlicense, and the dual-permissive `MIT AND ISC`). This includes the agent-runtime stack itself — `deepagents`, `langchain`, `@langchain/anthropic`, `@langchain/core`, `@langchain/langgraph`, `@langchain/langgraph-checkpoint-postgres`, `@langchain/mcp-adapters`, and `@langchain/openai` are all MIT-licensed. Each upstream package's `LICENSE` file is installed by pnpm into `node_modules/<pkg>/` and preserved in any deployment artifact that includes those modules. Cogniplane Core does not reproduce per-dependency notice text inline here because none of these licenses require centralized attribution beyond the per-package `LICENSE` files.

For an exact, version-pinned list at any point in time, run:

```bash
pnpm licenses list --prod
```

## Updates to this file

Run the `pnpm licenses list --prod --json` audit on dependency upgrades and update the counts above when a new license category appears, when an existing dep changes license, or when an upstream package starts shipping a `NOTICE` file. Counts are accurate as of the published commit; CI gates license categories (copyleft / source-available rejection), not exact counts, so small drift in the totals between releases is expected.
