# Writing an overlay

An overlay is a separate workspace package that adds tools, integrations, and routes to the platform. Core calls its bootstrap through `attachOverlays(...)` during dependency construction. It provides managed-tool registries and an integration registry. Core owns the bootstrap contract in `apps/backend/src/overlay-contracts.ts`.

This is the same mechanism Cogniplane uses for its private SharePoint/Microsoft 365 integration: it lives in a workspace package outside `apps/backend/`, is wired in by a one-file shim, and ships nothing into core's source tree.

## When you want an overlay

- Add a new managed tool the agent can call (e.g. `slack_post_message`).
- Add a new integration the operator can configure per tenant (OAuth flow, connection state, status badge).
- Add new HTTP routes scoped to that integration (settings page, callbacks).

If you only want to change a single core behavior (e.g. swap the runtime adapter), don't write an overlay — fork the relevant module. Overlays are for additive surface area.

## The two extension surfaces

The platform has **two** registries the overlay touches. They are intentionally different shapes.

### 1. Per-instance registries (passed via `attachOverlays` input)

`ManagedToolCatalog` and `ManagedToolFactoryRegistry` live as instances on `AppDependencies`. They are constructed once per `buildAppDependencies()` call and passed into your overlay's `bootstrap(...)`. Both throw on duplicate keys.

```ts
input.managedToolCatalog.register([
  { name: "myint_read_thing", description: "...", readOnly: true,  tenantConfigurable: false, category: "myint" },
  { name: "myint_write_thing", description: "...", readOnly: false, tenantConfigurable: false, category: "myint" }
]);

input.managedToolFactoryRegistry.register("myint", (coreDeps) =>
  createMyintTools({
    myintConnections: myintConnectionService,
    storage: coreDeps.storage,
    writeRuntimeFile: coreDeps.writeRuntimeFile
  })
);
```

The factory key (`"myint"` above) is a domain identifier, not a tool name — one factory typically produces multiple tool definitions. Pick something stable; collisions throw at boot.

Set each catalog entry's `category` to the factory key. The graph evaluates Policy Center rules with the catalog category before a tool call, and the gateway evaluates them again with the factory key. If the two values differ, a `require_approval` rule on that category never shows an approval prompt, and the gateway rejects the call.

### 2. Static catalog and app-owned integration hooks

`registerIntegration(...)` stores immutable catalog metadata. It accepts names, tool IDs, configuration fields, and static OAuth callback paths. It does not accept connection probes or callback handlers.

Each `buildAppDependencies()` creates an `IntegrationRegistry` and passes it to the overlay as `input.integrationDescriptors`. Attach services to that instance. Another app in the same process has its own probes and OAuth handlers.

```ts
import {
  getIntegrationDescriptor,
  registerIntegration
} from "@cogniplane/backend/src/services/integrations/integration-registry";

const descriptor = {
  id: "myint",
  name: "My Integration",
  description: "Short description",
  longDescription: "Description for the integrations page.",
  logoSlug: "myint",
  status: "available" as const,
  category: "communication",
  readToolIds: ["myint_read_thing"],
  writeToolIds: ["myint_write_thing"],
  configMode: "none" as const,
  oauthCallbackPaths: ["/integrations/myint/callback"]
};

if (!getIntegrationDescriptor(descriptor.id)) registerIntegration(descriptor);
// An overlay can add metadata after the app took its catalog snapshot.
if (!input.integrationDescriptors.get(descriptor.id)) {
  input.integrationDescriptors.register(descriptor);
}
input.integrationDescriptors.setRuntimeWiring(descriptor.id, {
  connectionProbe: myintConnectionService,
  oauthRoutes: {
    paths: descriptor.oauthCallbackPaths,
    register: (app) => registerMyintCallbackRoutes(app, { myintConnectionService })
  }
});
```

Register metadata once, then attach fresh live hooks for each app. No overlay registration flag or reset helper is needed. The host reads callback paths and registers OAuth routes from this app's registry after the overlay finishes bootstrapping.

## Required call order

Inside `bootstrap(input)`, the order matters:

1. **Construct your stores and services** — `MyintConnectionStore`, `MyintConnectionService`, etc.
2. Register catalog metadata if absent and add it to the app registry.
3. Attach live hooks with `input.integrationDescriptors.setRuntimeWiring(...)`.
4. **Register the catalog and factory** on the per-instance registries.
5. Return `OverlayHandles` with an `attachRoutes(app)` callback and any optional probes core reads. Keep services and stores inside the overlay.

The host's `attachOverlays(...)` shim calls `bootstrap(...)` from `app-dependencies.ts`, then later calls `attachRoutes(app)` from `app-bootstrap.ts` after every other route group is registered.

## Tenant-configurable tools vs integration-gated tools

A managed tool is **either** in the per-tenant Agent settings picker **or** gated by an integration. Never both. The catalog entry's `tenantConfigurable` flag controls this:

- `tenantConfigurable: true` — appears in the Agent settings checkbox list. The user toggles it on/off per tenant. Use this for tools that work standalone (`session_context`, `write_artifact`).
- `tenantConfigurable: false` — invisible to the per-tenant picker. Authorization comes from the integrations system: the tool is enabled iff the integration is enabled for the tenant AND the integration's `connectionProbe` reports a live connection. Use this for any tool that depends on an integration.

Putting an integration-owned tool in the picker would bypass the `tenant_integrations` toggles and the readiness checks. That's why the factory test asserts every tool name exposed by an integration descriptor's `readToolIds`/`writeToolIds` is registered with `tenantConfigurable: false`.

## OAuth allowlist propagation

When `oauthRoutes.paths` is set, the auth middleware adds those paths to its public allowlist (so the OAuth provider's redirect to `/integrations/myint/callback` doesn't get bounced to the login page). Two requirements:

- **Exact paths only**, not prefixes. The allowlist uses exact-match against a `Set<string>` to defend against prefix-smuggling.
- **Stable paths**. Once shipped, don't rename. Auth allowlist drift is the kind of thing that breaks silently in production.

## Wiring the host

`apps/backend/src/overlay-contracts.ts` defines the contract:

- `AttachOverlaysInput` defines what core gives an overlay. Store and registry types expose selected methods, such as `Pick<ArtifactStore, "create">`. `config` holds settings for OAuth state JWTs, secret encryption, and redirects. `loadIntegrationEnablement(tenantId, integrationId)` returns the tenant toggles and platform status.
- `OverlayHandles` defines what core reads back: `attachRoutes(app)` and the optional `getMicrosoftConfigured` probe.
- `OverlayBootstrap` has the signature `(input: AttachOverlaysInput) => OverlayHandles`. Core calls it once for each `buildAppDependencies()`. Return handles that belong to that app only.

Your overlay's `bootstrap` implements `OverlayBootstrap`. The host shim at `apps/backend/src/overlays.ts` assigns it to `attachOverlays`:

```ts
import { bootstrap as myintBootstrap } from "@your-scope/myint-overlay-backend";

import type { OverlayBootstrap } from "./overlay-contracts.js";

export const attachOverlays: OverlayBootstrap = myintBootstrap;
```

To combine several overlays, call each `bootstrap` in the shim and return one `OverlayHandles` whose `attachRoutes` calls each overlay's `attachRoutes`.

The OSS distribution ships a no-op stub at this path. It implements the same `OverlayBootstrap` type, and your private tree replaces it.

If your overlay needs to expose a value back to core (e.g. a "Microsoft is configured?" probe used by the tenant settings response), add an optional field to `OverlayHandles` in `overlay-contracts.ts`. Core reads it through `deps.overlays.<field>`; the OSS no-op build leaves it `undefined`.

The contract types limit what core passes at compile time. They are not a sandbox: an overlay runs in the backend process and can import any backend module. Overlay packages still import some backend helpers directly, such as `withTenantScope`, `requireRole`, `serialize`, the OAuth state helpers, and the static catalog functions `registerIntegration` / `getIntegrationDescriptor`. Until those imports move behind the contract, the contract stays in `apps/backend/src` and is not a separate workspace package.

## Overlay package layout

```
my-overlay-backend/
├── package.json                # private; not published
├── src/
│   ├── index.ts                # exports `bootstrap`, types
│   ├── integrations/
│   │   └── register-myint-descriptor.ts
│   ├── managed-tools/
│   │   └── myint-tools.ts      # exports MYINT_TOOL_CATALOG + createMyintTools
│   ├── routes/
│   │   ├── myint-callback-routes.ts
│   │   └── myint-settings-routes.ts
│   └── services/
│       ├── myint-connection-service.ts
│       └── myint-connection-store.ts
└── tsconfig.json
```

Add the package to `pnpm-workspace.yaml` (private tree only — the OSS sync drops the `private/*` glob) and reference it from `apps/backend/package.json` `optionalDependencies`. The optional flag means a public clone without the package still installs cleanly.

## Tests

- Test your overlay's tool factories like core does — colocated `*.test.ts`, in-memory fakes for store-shaped collaborators, Vitest with `expect`/`vi.fn()`.
- Test `bootstrap(...)` with two separate inputs, as two apps in one process do. Each app registry must get its own probes and OAuth handlers, and the second call must not throw on the static catalog.
- Add an integration assertion that every tool id in the descriptor's `readToolIds`/`writeToolIds` is actually registered in the catalog with `tenantConfigurable: false`. (See `services/integrations/oss-subset.test.ts` for the shape.)

## Worth reading

- `apps/backend/src/services/managed-tools/factory.ts` — the registry contract.
- `apps/backend/src/services/managed-tools/catalog.ts` — same for catalog entries.
- `apps/backend/src/services/integrations/integration-registry.ts` — the descriptor + runtime wiring API.
- `apps/backend/src/services/integrations/register-builtin-integrations.ts` — the canonical example: GitHub and Notion descriptors registered the way an overlay would.
- `apps/backend/src/overlay-contracts.ts` — the bootstrap contract.
- `apps/backend/src/overlays.ts` — the OSS no-op stub. Replace with your wiring in your private tree.
