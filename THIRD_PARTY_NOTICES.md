# Third-Party Notices

Cogniplane Core is distributed under the [GNU AGPL-3.0](LICENSE) (or, for commercial licensees, under terms negotiated separately — see [COMMERCIAL.md](COMMERCIAL.md)). It depends on third-party software released under a variety of licenses. This file is the consolidated attribution and license notice for those components.

The list below is generated from `pnpm licenses list --prod` on the published lockfile. The authoritative source for what's actually installed at any given commit is `pnpm-lock.yaml` plus each package's own `LICENSE` file in `node_modules/`. This file describes the obligations Cogniplane Core inherits when redistributing the dependency tree.

## Summary of license categories

| License | Count | Notes |
|---|---:|---|
| MIT | 316 | Permissive; attribution preserved in upstream `LICENSE` files |
| Apache-2.0 | 100 | Permissive with patent grant; see explicit list below |
| ISC | 20 | Permissive; equivalent to simplified BSD |
| BlueOak-1.0.0 | 11 | Permissive (Blue Oak Council model license) |
| BSD-3-Clause | 7 | Permissive |
| BSD-2-Clause | 1 | Permissive |
| 0BSD | 1 | Public-domain-equivalent |
| CC0-1.0 | 1 | Public-domain-equivalent |
| Apache-2.0 AND BSD-3-Clause | 1 | Both apply (`@bufbuild/protobuf`) |
| MIT AND Zlib | 1 | Both apply (`pako`) |
| MIT OR GPL-3.0-or-later | 1 | Cogniplane elects MIT (`jszip`) |
| LGPL-3.0-or-later | 1 | Native binary, dynamic-link only (`@img/sharp-libvips-linux-x64`) |
| CC-BY-4.0 | 1 | Attribution-required (`caniuse-lite`, devtime data) |
| Proprietary (Anthropic) | 2 | `@anthropic-ai/claude-agent-sdk` + linux-x64 native binary |

In addition, the unified E2B sandbox template installs the [`@openai/codex`](https://github.com/openai/codex) CLI (Apache-2.0) at template-build time. It is not in `pnpm-lock.yaml` because it's installed via `npm install -g` inside the sandbox image, not as a workspace dependency. It is included in the redistribution surface and listed below.

## Apache License, Version 2.0

The following dependencies are licensed under the Apache License, Version 2.0. Cogniplane Core preserves each upstream package's `LICENSE` file as installed by pnpm. None of the listed upstream packages ship a `NOTICE` file in the published distribution; if a future upstream version begins shipping one, the obligation to preserve and propagate it is inherited automatically through `node_modules/`.

The full text of Apache-2.0 is available at <https://www.apache.org/licenses/LICENSE-2.0>.

Apache-2.0 dependencies (workspace `--prod`):

```
@aws-crypto/crc32                    @smithy/eventstream-serde-browser
@aws-crypto/crc32c                   @smithy/eventstream-serde-config-resolver
@aws-crypto/sha1-browser             @smithy/eventstream-serde-node
@aws-crypto/sha256-browser           @smithy/eventstream-serde-universal
@aws-crypto/sha256-js                @smithy/fetch-http-handler
@aws-crypto/supports-web-crypto      @smithy/hash-blob-browser
@aws-crypto/util                     @smithy/hash-node
@aws-sdk/client-s3                   @smithy/hash-stream-node
@aws-sdk/core                        @smithy/invalid-dependency
@aws-sdk/crc64-nvme                  @smithy/is-array-buffer
@aws-sdk/credential-provider-env     @smithy/md5-js
@aws-sdk/credential-provider-http    @smithy/middleware-content-length
@aws-sdk/credential-provider-ini     @smithy/middleware-endpoint
@aws-sdk/credential-provider-login   @smithy/middleware-retry
@aws-sdk/credential-provider-node    @smithy/middleware-serde
@aws-sdk/credential-provider-process @smithy/middleware-stack
@aws-sdk/credential-provider-sso     @smithy/node-config-provider
@aws-sdk/credential-provider-web-identity   @smithy/node-http-handler
@aws-sdk/lib-storage                 @smithy/property-provider
@aws-sdk/middleware-bucket-endpoint  @smithy/protocol-http
@aws-sdk/middleware-expect-continue  @smithy/querystring-builder
@aws-sdk/middleware-flexible-checksums  @smithy/querystring-parser
@aws-sdk/middleware-host-header      @smithy/service-error-classification
@aws-sdk/middleware-location-constraint  @smithy/shared-ini-file-loader
@aws-sdk/middleware-logger           @smithy/signature-v4
@aws-sdk/middleware-recursion-detection  @smithy/smithy-client
@aws-sdk/middleware-sdk-s3           @smithy/types
@aws-sdk/middleware-ssec             @smithy/url-parser
@aws-sdk/middleware-user-agent       @smithy/util-base64
@aws-sdk/nested-clients              @smithy/util-body-length-browser
@aws-sdk/region-config-resolver      @smithy/util-body-length-node
@aws-sdk/signature-v4-multi-region   @smithy/util-buffer-from
@aws-sdk/token-providers             @smithy/util-config-provider
@aws-sdk/types                       @smithy/util-defaults-mode-browser
@aws-sdk/util-arn-parser             @smithy/util-defaults-mode-node
@aws-sdk/util-endpoints              @smithy/util-endpoints
@aws-sdk/util-locate-window          @smithy/util-hex-encoding
@aws-sdk/util-user-agent-browser     @smithy/util-middleware
@aws-sdk/util-user-agent-node        @smithy/util-retry
@aws-sdk/xml-builder                 @smithy/util-stream
@aws/lambda-invoke-store             @smithy/util-uri-escape
@connectrpc/connect                  @smithy/util-utf8
@connectrpc/connect-web              @smithy/util-waiter
@img/sharp-linux-x64                 @smithy/uuid
@smithy/chunked-blob-reader          @swc/helpers
@smithy/chunked-blob-reader-native   baseline-browser-mapping
@smithy/config-resolver              cluster-key-slot
@smithy/core                         denque
@smithy/credential-provider-imds     detect-libc
@smithy/eventstream-codec            sharp
```

The `@openai/codex` CLI (Apache-2.0) installed inside the E2B sandbox template is also covered here. Source and license: <https://github.com/openai/codex>.

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

## Proprietary: Anthropic Agent SDK

The Claude runtime depends on:

- `@anthropic-ai/claude-agent-sdk` (TypeScript SDK)
- `@anthropic-ai/claude-agent-sdk-linux-x64` (native CLI binary)

Both are published by Anthropic PBC and are **not open-source**. They are governed by Anthropic's [Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms), which apply to anyone using Cogniplane Core's Claude runtime.

Operational consequences for self-hosters and commercial licensees:

- A paid Anthropic API key from <https://console.anthropic.com> is required. Consumer subscriptions (Free/Pro/Max) and OAuth tokens from the consumer apps are **not supported** by the Agent SDK.
- The redistributor (Cogniplane Core) does not relicense the Agent SDK. Each operator and tenant uses the SDK under their own Anthropic account, subject to Anthropic's terms.
- The Codex runtime (`@openai/codex`, Apache-2.0) is fully open-source and remains the default. The Claude runtime is opt-in.

Source for the SDK (binary published, source publicly browsable): <https://github.com/anthropics/claude-agent-sdk-typescript>.

## Permissive bulk: MIT, ISC, BlueOak-1.0.0, BSD-2/3-Clause, 0BSD, CC0-1.0

The remaining ~360 production dependencies are under permissive licenses (MIT, ISC, BlueOak-1.0.0, BSD-2-Clause, BSD-3-Clause, 0BSD, CC0-1.0). Each upstream package's `LICENSE` file is installed by pnpm into `node_modules/<pkg>/` and preserved in any deployment artifact that includes those modules. Cogniplane Core does not reproduce per-dependency notice text inline here because none of these licenses require centralized attribution beyond the per-package `LICENSE` files.

For an exact, version-pinned list at any point in time, run:

```bash
pnpm licenses list --prod
```

## Updates to this file

Run the `pnpm licenses list --prod --json` audit on dependency upgrades and update the counts above when a new license category appears, when an existing dep changes license, or when an upstream package starts shipping a `NOTICE` file. Counts are accurate as of the published commit; CI gates license categories (copyleft / source-available rejection), not exact counts, so small drift in the totals between releases is expected.
