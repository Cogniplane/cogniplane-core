# Writing an overlay

An **overlay** is a separate workspace package that adds tools, integrations, and routes to the platform without forking core. The platform exposes two extension surfaces — managed-tool registries and the integration registry — and an `attachOverlays(...)` shim that the host calls during dependency construction.

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
  { name: "myint_read_thing", description: "...", readOnly: true,  tenantConfigurable: false },
  { name: "myint_write_thing", description: "...", readOnly: false, tenantConfigurable: false }
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

### 2. Module-level registry (free functions)

`registerIntegration(...)`, `setIntegrationRuntimeWiring(...)`, and `listIntegrationOAuthCallbackPaths()` are module-level free functions in `services/integrations/integration-registry.ts`. They are module-level, not instance-based, because the OAuth callback paths are aggregated into the auth middleware's public-path allowlist at boot — before any DI container is wired.

```ts
import {
  registerIntegration,
  setIntegrationRuntimeWiring
} from "@cogniplane/backend/src/services/integrations/integration-registry";

// Static descriptor — registered once per process.
registerIntegration({
  id: "myint",
  name: "My Integration",
  description: "Short blurb",
  longDescription: "Longer paragraph for the integrations page.",
  logoSlug: "myint",
  status: "available",
  category: "communication",
  readToolIds:  ["myint_read_thing"],
  writeToolIds: ["myint_write_thing"],
  configMode: "oauth_app",
  configFields: [
    { key: "client_id", label: "Client ID", type: "text",     required: true },
    { key: "client_secret", label: "Client Secret", type: "password", required: true }
  ],
  docsUrl: "https://docs.example.com/cogniplane-myint"
});

// Live wiring — attached lazily so the connection service can come from a
// per-app instance.
setIntegrationRuntimeWiring("myint", {
  connectionProbe: myintConnectionService,
  oauthRoutes: {
    paths: ["/integrations/myint/callback"],
    register: (app) => registerMyintCallbackRoutes(app, { myintConnectionService })
  }
});
```

Because `registerIntegration` is module-level state, your overlay's `bootstrap(...)` must guard descriptor registration against re-entry:

```ts
let descriptorRegistered = false;

export function bootstrap(input: MyintOverlayBootstrapInput): MyintOverlay {
  // ...
  if (!descriptorRegistered) {
    descriptorRegistered = true;
    registerIntegration({ /* ... */ });
  }
  setIntegrationRuntimeWiring("myint", { /* fresh per-app wiring */ });
  // ...
}

export function __resetMyintOverlayForTesting(): void {
  descriptorRegistered = false;
}
```

The catalog and factory registry are per-instance, so they don't need a reset hook — every `buildAppDependencies()` builds fresh registries.

## Required call order

Inside `bootstrap(input)`, the order matters:

1. **Construct your stores and services** — `MyintConnectionStore`, `MyintConnectionService`, etc.
2. **Register the descriptor** (idempotent guard).
3. **Attach runtime wiring** — `setIntegrationRuntimeWiring(...)`.
4. **Register the catalog and factory** on the per-instance registries.
5. **Return the bootstrap result** — including any services core needs (e.g. for the runtime invalidator) and an `attachOverlayRoutes(app)` callback.

The host's `attachOverlays(...)` shim calls `bootstrap(...)` from `app-dependencies.ts`, then later calls `attachOverlayRoutes(app)` from `app-bootstrap.ts` after every other route group is registered.

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

The host expects an `apps/backend/src/overlays.ts` file that calls every overlay's `bootstrap(...)` and returns an `OverlayHandles` shape:

```ts
import {
  bootstrap as myintBootstrap,
  type MyintOverlay,
  type MyintOverlayBootstrapInput
} from "@your-scope/myint-overlay-backend";

export type AttachOverlaysInput = MyintOverlayBootstrapInput;

export type OverlayHandles = {
  attachRoutes: (app: FastifyInstance) => void;
};

export function attachOverlays(input: AttachOverlaysInput): OverlayHandles {
  const myint: MyintOverlay = myintBootstrap(input);
  return {
    attachRoutes: (app) => {
      myint.attachOverlayRoutes(app);
    }
  };
}
```

The OSS distribution ships a no-op stub at this path — your private tree replaces it.

If your overlay needs to expose a service back to core (e.g. a "Microsoft is configured?" probe used by the tenant settings response), add it as a field on `OverlayHandles`. Core reads it through `deps.overlays.<field>` and treats it as optional — the OSS no-op build leaves it `undefined`.

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
- Test `bootstrap(...)` end-to-end by calling it twice with `__resetMyintOverlayForTesting()` between to confirm idempotency.
- Add an integration assertion that every tool id in the descriptor's `readToolIds`/`writeToolIds` is actually registered in the catalog with `tenantConfigurable: false`. (See `services/integrations/oss-subset.test.ts` for the shape.)

## Worth reading

- `apps/backend/src/services/managed-tools/factory.ts` — the registry contract.
- `apps/backend/src/services/managed-tools/catalog.ts` — same for catalog entries.
- `apps/backend/src/services/integrations/integration-registry.ts` — the descriptor + runtime wiring API.
- `apps/backend/src/services/integrations/register-builtin-integrations.ts` — the canonical example: GitHub and Notion descriptors registered the way an overlay would.
- `apps/backend/src/overlays.ts` — the OSS no-op stub. Replace with your wiring in your private tree.
