# MCP proxy signature

Scope: how an upstream MCP server verifies requests from the Cogniplane gateway
and prevents replay. The gateway side is in
[tools](architecture/tools.md#mcp-gateway).

`apps/backend/src/lib/mcp-proxy-signature.ts` signs each proxy request (version
`v2`) with HMAC-SHA256 over `X-Framework-*` headers: tenant, server, user,
session, runtime, timestamp (Unix ms), nonce (128 bits), and the SHA-256 of the
exact body bytes.

- The key for one tenant and server is HKDF-SHA256 of the signing root
  (`MCP_UPSTREAM_SIGNING_ROOT_SECRET`, else a subkey of
  `DATA_ENCRYPTION_SECRET`), with the tenant id and server id in the HKDF info.
  Give each upstream only its own key (`proxyServerSigningKey`). Startup refuses
  the removed v1 variable `MCP_UPSTREAM_SIGNING_SECRET`.
- The tenant id comes from the runtime token; the server id comes from the
  tenant's server registration.

## Get an upstream key

No route or UI shows the key. Compute it from the repository root, with the
backend's secrets in the environment (never give the upstream the root secret):

```bash
TENANT_ID=<tenant id> SERVER_ID=<server id> pnpm exec tsx -e '
import { proxyServerSigningKey } from "./apps/backend/src/lib/mcp-proxy-signature.ts";
import { proxySignatureSecret } from "./apps/backend/src/lib/derived-secrets.ts";
const e = process.env;
console.log(proxyServerSigningKey(
  proxySignatureSecret(e.DATA_ENCRYPTION_SECRET!, e.MCP_UPSTREAM_SIGNING_ROOT_SECRET || undefined),
  { tenantId: e.TENANT_ID!, serverId: e.SERVER_ID! }));'
```

The result is base64url text; the HMAC key is the UTF-8 bytes of that text. Give
it to the upstream through its own secret store.

## Verify requests

- The upstream verifies each request with `verifyProxyHeaders` from
  `apps/backend/src/lib/mcp-proxy-signature.ts` (no package is published; copy
  the file, or port it):
  ```ts
  const result = verifyProxyHeaders(headers, rawBody, serverKey, { serverId, maxAgeMs });
  ```
  It accepts `now - maxAgeMs <= timestamp <= now + maxFutureSkewMs` (default
  `DEFAULT_MAX_FUTURE_SKEW_MS`) and returns `keepNonceUntil`.
- Replay protection is the upstream's job. After a successful verification, run
  these steps as one atomic operation on a durable nonce store, with one
  retention `R` (at least the largest `maxAgeMs` of all verifiers) and `until =
  timestamp + R`:
  1. `now = max(callerNow, highWater)`; `highWater = now` (shared, never moves
     back).
  2. Reject as stale if `until < now`.
  3. Delete entries with `until < now`.
  4. Reject as a replay if the nonce exists.
  5. Insert the nonce with `until`.
- Do not raise `maxAgeMs` above `R`. The store must not lose a nonce or move
  `highWater` back, including on restart or failover. Wall-clock key expiry is
  not sufficient. In Redis, use one Lua script, with `highWater` in one key and
  the nonces in a sorted set scored by `until`, in the same hash slot.

