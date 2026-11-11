# Build an overlay or connector

Scope: add managed tools, an integration, or integration routes, as an overlay
package or as a built-in connector module. Operator setup of the bundled
connectors is in [connectors](connectors.md). Security rules for tools are in
[tools](architecture/tools.md).

- An overlay is a workspace package. Core calls its `bootstrap(input)` once for
  each `buildAppDependencies()` and reads back `OverlayHandles`. The contract is
  `apps/backend/src/overlay-contracts.ts`.
- The bundled SharePoint overlay (`private/sharepoint-overlay-*`) uses this
  contract. `apps/backend/src/overlays.ts` and `apps/frontend/src/overlays.ts`
  register it.
- The GitHub, Notion and Jira connectors are built-in modules that follow the
  same steps ([Built-in connectors](#built-in-connectors)).
- Use an overlay to add features. To change a core behavior, change core.

## Bootstrap steps

Inside `bootstrap(input)`, in this order:

1. Construct the overlay's stores and services.
2. Register the static integration descriptor if it is absent, and add it to
   this app's registry ([Integration descriptor](#integration-descriptor)).
3. Attach live hooks with `input.integrationDescriptors.setRuntimeWiring(...)`.
4. Register catalog entries and the tool factory ([Managed
   tools](#managed-tools)) and any PII import scopes ([PII import
   scopes](#pii-import-scopes)).
5. Return `OverlayHandles`. It holds `attachRoutes(app, controls)`; a value that
   core must read is an optional field that you add to the type
   ([Routes](#routes)).

Core calls `bootstrap` from `app-dependencies.ts` and `attachRoutes` from
`app-bootstrap.ts`, after all other routes. Return handles that belong to this
app only: two apps in one process must not share probes or OAuth handlers.

## Managed tools

`input.managedToolCatalog` and `input.managedToolFactoryRegistry` are per-app
instances. Both throw on a duplicate key.

```ts
input.managedToolCatalog.register([
  { name: "myint_read_thing", description: "...", readOnly: true, tenantConfigurable: false, category: "myint" },
  { name: "myint_write_thing", description: "...", readOnly: false, tenantConfigurable: false, category: "myint" }
]);
input.managedToolFactoryRegistry.register("myint", (coreDeps) =>
  createMyintTools({ myintConnections: myintConnectionService, storage: coreDeps.storage, writeRuntimeFile: coreDeps.writeRuntimeFile })
);
```

- The factory key (`"myint"`) names a domain; one factory makes several tools.
  The `category` and `tenantConfigurable` rules are the same as for core tools:
  [add a core managed tool](architecture/tools.md#add-a-core-managed-tool).

## Integration descriptor

```ts
// Relative path from the overlay package, as the SharePoint overlay does.
import { getIntegrationDescriptor, registerIntegration } from "../../../apps/backend/src/services/integrations/integration-registry.js";

const descriptor = {
  id: "myint", name: "My Integration", description: "Short description",
  longDescription: "Description for the integrations page.", logoSlug: "myint",
  status: "available" as const, category: "communication",
  readToolIds: ["myint_read_thing"], writeToolIds: ["myint_write_thing"],
  configMode: "none" as const, oauthCallbackPaths: ["/integrations/myint/callback"]
};

if (!getIntegrationDescriptor(descriptor.id)) registerIntegration(descriptor);
if (!input.integrationDescriptors.get(descriptor.id)) input.integrationDescriptors.register(descriptor);
input.integrationDescriptors.setRuntimeWiring(descriptor.id, {
  connectionProbe: myintConnectionService,
  oauthRoutes: {
    paths: descriptor.oauthCallbackPaths,
    register: (app) => registerMyintCallbackRoutes(app, { myintConnectionService })
  }
});
```

- `registerIntegration` keeps static metadata only: names, tool ids,
  configuration fields, callback paths. Probes and handlers go to the per-app
  registry (`input.integrationDescriptors`).
- OAuth callback paths join the public auth allowlist. Use exact paths, not
  prefixes, and do not rename a released path.
- Add the logo as described in `apps/frontend/public/integrations/README.md`.

## PII import scopes

An overlay that imports files registers each source:

```ts
const MYINT_IMPORT_PII_SCOPE = { subjectKind: "myint_import", scopeKey: "myintImports", defaultOn: true } as const;
input.piiImportScopes.register(MYINT_IMPORT_PII_SCOPE);
// Check access before you fetch the file; begin returns the ticket.
const ticket = await input.uploadAdmission.begin({ tenantId, sessionId, userId });
const result = await input.uploadAdmission.admit(ticket, { ...file, source: MYINT_IMPORT_PII_SCOPE.subjectKind });
if (result.kind !== "admitted") {
  // "blocked" (PII policy) or "scan_failed": tell the user; do not report success.
  throw new MyintImportError(result.kind);
}
return result.artifact;
```

- `subjectKind` is the upload source; `scopeKey` is the tenant policy toggle;
  `defaultOn` applies until a tenant saves a value. All three are stored: do not
  change them after release.
- The registry refuses duplicates and core names (`chatPrompts`, `uploads`,
  `chat_prompt`, `upload`, `skill_corpus`), and freezes after bootstrap.
- Label the toggle with `registerPiiScopeLabel({ scopeKey, label })`
  (`apps/frontend/src/lib/pii-scope-labels.ts`).

## Routes

- A route that changes where tenant data goes (for example the overlay's OAuth
  app settings) calls `controls.dataRoutes.requireStepUpForOverlay(request,
  reply, action)` with an action from `OVERLAY_STEP_UP_ACTIONS`, and puts
  `controls.dataRoutes.ownerNotice(...)` on the change's audit event ([data
  routes](architecture/sensitive-changes.md#data-routes)).
- A route that saves integration settings writes with
  `input.stores.integrationStates.applyChanges`. It writes only the keys that
  the request sets, onto the locked row, and records the signed-in user as
  `updatedBy`. A toggle or key that another admin changed meanwhile stays.
  Example: `setTenantMicrosoftConfig` in the SharePoint overlay.
- Fetch a user-supplied URL only with the public-host checks, `undici` `fetch`
  and `ssrfSafeAgent` ([outbound requests](security.md#outbound-requests)).
- To expose a value to core (for example "is Microsoft configured?"), add an
  optional field to `OverlayHandles`; core reads `deps.overlays.<field>`.

## Frontend registration

`apps/frontend/src/overlays.ts` imports the overlay's frontend `register` module
for its side effects. The SharePoint example
(`private/sharepoint-overlay-frontend/src/bootstrap/register.tsx`) uses these
extension points:

| Function | Adds |
|---|---|
| `registerSettingsSection` (`app/settings/settings-sections`) | Account row and `/settings/<id>` page |
| `registerFileSource` (`hooks/use-file-sources`) | A source in the file picker |
| `registerArtifactOrigin` (`lib/artifact-origins`) | Origin label of imported artifacts |
| `registerPiiScopeLabel` (`lib/pii-scope-labels`) | Label of a PII import scope toggle |

## Host wiring

`apps/backend/src/overlays.ts` assigns the bootstrap:

```ts
import { bootstrap as myintBootstrap } from "@your-scope/myint-overlay-backend";
import type { OverlayBootstrap } from "./overlay-contracts.js";

export const attachOverlays: OverlayBootstrap = myintBootstrap;
```

To use several overlays (for example yours and SharePoint), call each
`bootstrap` and return one `OverlayHandles`: its `attachRoutes` calls each
overlay's `attachRoutes`, and each optional field takes the value of the overlay
that provides it. Add the package to `pnpm-workspace.yaml` and to
`apps/backend/package.json`.

The contract types limit what core passes, but they are not a sandbox: an
overlay runs in the backend process. Overlays still import some backend helpers
directly (`withTenantScope`, `requireRole`, `serialize`, OAuth state helpers,
`registerIntegration`), so the contract stays in `apps/backend/src`.

Package layout:

```
my-overlay-backend/
  package.json            # private
  src/index.ts            # exports bootstrap
  src/integrations/       # descriptor
  src/managed-tools/      # catalog entries and factory
  src/routes/             # callback and settings routes
  src/services/           # connection service and store
```

## Built-in connectors

`services/integrations/github/github-connector.ts`, `notion/notion-connector.ts`
and `pipedream/jira-connector.ts` follow the bootstrap steps inside core, with
these differences:

- They get `BuiltinConnectorInput` (`services/connectors/connector-module.ts`):
  the overlay input plus the full `AppConfig` and a logger.
- `services/connectors/builtin-connectors.ts` runs them in a fixed order
  (`tools/list` order: [tools](architecture/tools.md#mcp-gateway)).
- `register-builtin-integrations.ts` registers their descriptors before the app
  takes its catalog snapshot.
- A module can return typed services that core routes read (the GitHub module
  does).

## Tests

- Test tool factories with colocated `*.test.ts` and in-memory fakes.
- Call `bootstrap` with two separate inputs: each app registry must get its own
  probes and handlers, and the second call must not throw on the static catalog.
- Check that every tool id in the descriptor is in the catalog with
  `tenantConfigurable: false` (see `apps/backend/src/app-dependencies.test.ts`).
