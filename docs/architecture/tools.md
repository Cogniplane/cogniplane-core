# Tools and the MCP gateway

Scope: the MCP gateway, managed and proxy tools, member credentials and personal
connections. Human approvals: [approvals](approvals.md). Tenant rules: [Policy
Center](policy-center.md).

## MCP gateway

`/mcp/:serverId` (`routes/mcp.ts`) receives JSON-RPC 2.0 from the runtime's
`GatewayMcpClient`. Each server has one mode:

- `managed`: `ManagedToolFactoryRegistry` (`services/managed-tools/factory.ts`)
  dispatches the call. `ManagedToolCatalog`
  (`services/managed-tools/catalog.ts`) is the allowlist; an unknown tool name
  is rejected. `tools/list` returns the tools in factory registration order
  (`factory.ts`), not catalog order; that order is in the header comment of
  `register-builtin-managed-tools.ts`.
- `proxy`: the gateway forwards the call to the server's upstream URL with
  signed identity headers ([MCP proxy signature](../mcp-proxy-signature.md);
  signer: `lib/mcp-proxy-signature.ts`) and the configured upstream
  authentication. It never forwards a user JWT. Limits:
  `MCP_UPSTREAM_TIMEOUT_MS` per call, `MCP_UPSTREAM_MAX_RESPONSE_BYTES` per
  response.

When a tenant and the system share a server ID, the runtime catalog and the
gateway select from the rows visible to the member. Both skip disabled rows.
Only test users can use unpublished rows. If both rows qualify, the tenant row
wins. Admins can still open a disabled tenant row to edit it.

Admin setup of a proxy server: [connectors](../connectors.md#proxy-mcp-servers).

Server administration is in `McpAdminService`
(`services/mcp/mcp-admin-service.ts`). Admin > Connections uses two operations.
`POST /admin/mcp-servers/setup` and `PUT /admin/mcp-servers/:serverId/setup`
save a connection and its audience in one transaction.
`PUT /admin/mcp-servers/:serverId/inherited-availability` sets the audience of
an inherited system connection. The single-step routes (create, update,
disable, publish, unpublish) stay for other HTTP clients. The browser client
does not call them.

Proxy upstreams use public addresses by default. Admission rejects local and
reserved hosts, and each DNS lookup rejects any private or reserved answer.
The backend connects to that checked DNS result. For self-hosted LAN servers,
the operator must set `MCP_UPSTREAM_ALLOW_PRIVATE_ADDRESSES=true`. Existing
private servers also need this setting after an upgrade. It applies to all
tenants and every proxy request. See [outbound request rules](../security.md#outbound-requests).

Without the setting, a saved server with a private address sends no request.
To retire it, an admin saves it in Admin > Connections with the audience "off"
and the address unchanged. An update can keep a refused address only when it
does not change the address and leaves the server off
(`McpServerStore.updateMcpServer`). Each other save is refused until the
address is public, also a save that turns the server on again.

Connection test: `POST /admin/mcp-servers/:serverId/connection-test`
(`services/mcp/mcp-connection-test-service.ts`) sends `tools/list` with the
saved configuration. For per-member credentials it uses the admin's own. It
stores reachability, authentication and tool count in
`admin_mcp_connection_tests`. `MCP_CONNECTION_TEST_TIMEOUT_MS` bounds the whole
test. A request whose server version or config hash is stale returns 409.

Rules:

1. The runtime calls the gateway at `RUNTIME_GATEWAY_BASE_URL` (loopback only)
   with a session-scoped `Authorization: Bearer rt_...` header
   (`lib/auth-runtime-token.ts`; HMAC claims bind tenant, user, session and
   runtime). The token lives `RUNTIME_TOKEN_TTL_MS`; a session that runs longer
   gets `runtime_token_expired` until its runtime restarts. The gateway reads
   only this header, never a query-string token.
   Verification requires nonblank string `jti`, `sid`, `tid`, `uid` and `rid`
   claims and an ISO 8601 UTC `exp`. The token is invalid without any of them,
   and expires at the exact `exp` time. Its format uses HMAC-SHA256, not JWT
   headers or a caller-selected algorithm. Upgrade behavior:
   [runtime-token validation](../operations.md#upgrade-to-required-runtime-token-claims).
2. Every call needs a `toolContextId` that resolves in
   `ToolExecutionContextStore`
   (`services/auth/tool-execution-context-store.ts`).
   - The runtime sends it in `params._meta["cogniplane.ai/invocation"]`.
   - When that entry exists, the gateway ignores a `toolContextId` in the tool
     arguments, because the model wrote them.
   - Older fallbacks (arguments, URL, latest active context of the session) bind
     to the same tenant, session, user and runtime. Do not add new callers that
     depend on them.
   - The gateway reads an approval proof only from `_meta`.
3. The tool context holds the user, session, runtime, and a snapshot of the
   tenant's runtime policy for the turn. Admin changes during a turn do not
   change it. It expires `TOOL_CONTEXT_TTL_MS` after it is created ([startup
   rules](../configuration.md#startup-rules)); each approval round sets it to
   `TOOL_CONTEXT_TTL_MS` from that moment (`deep-agents-runtime-adapter.ts`).
4. A context records the owner's security version
   ([revocation](local-accounts.md#security-version-and-revocation)). Every
   lookup (`get`, `liveness`, `extend`, `findLatestActiveBySession`) also
   requires that the owner is still a member of the tenant, for interactive and
   scheduled contexts and for both login types. A member removal therefore
   stops the member's turns at their next tool call or model start on every
   replica, with the reason `security_change` ([roles](auth.md#roles)).
   - A context of an interactive or a scheduled turn names the execution of
     its turn (`executionId`). Each lookup refuses it when that execution does
     not hold an active lease with the same user and runtime: after a stop, a
     release, a lease expiry or a newer execution
     (`toolContextExecutionSql`, `services/session-execution-store.ts`). A call
     that waits at the gateway after its turn ends is refused.
   - A scheduled context that names no execution comes from a version before
     scheduled turns took a lease. It stays valid until its TTL
     (`SCHEDULER_JOB_TIMEOUT_MS` plus one minute), so such turns keep their
     tools during a rolling upgrade.
   - A tool call looks up its context two times. The first lookup binds the
     call. The gateway then waits for the integration check, the upstream tool
     metadata, Policy Center and the approval claim. The second lookup comes
     immediately before the action: the managed handler or the proxy
     `tools/call` request (`revalidateBoundToolContext` in
     `services/mcp/tool-context-binder.ts`). It reads the bound context id
     again, never the latest context of the session.
   - If the context is revoked, expired or no longer has its required execution
     at the second lookup, the action does not start and the call gets `-32000`.
     The execution checks and legacy exception above apply.
     A closed caller request also prevents dispatch. A claimed
     approval stays used.
   - The second lookup and the action are not one atomic step. A change that
     commits after the second lookup does not stop the action. When the
     caller closes its request, the gateway aborts the proxy request, but an
     upstream that received the call can complete it, and nothing recalls it.
     A managed handler gets no abort signal and runs to its end.
5. Never accept identity fields (`user_id`, `session_id`, tokens) from tool
   arguments.
6. Before a result reaches the runtime or telemetry, the gateway removes the
   server's upstream secret (raw and URL-encoded) and applies `redactSecrets()`
   (`services/redact-secrets.ts`) to the result and the JSON-RPC error
   (`services/mcp/scrub-upstream-credential.ts`). Tool events are redacted
   before they are saved.

Upstream MCP elicitation is not a confirmation: only approvals and Policy Center
at the gateway confirm an action.

## Tool errors

The gateway answers a refused or failed call with a JSON-RPC error: a Policy
Center block or an expired approval (`-32004`), a failed managed tool
(`-32000`). `gatewayErrorsAsResults`
(`services/deep-agents/gateway-mcp-client.ts`) gives such an error to the model
as a failed tool call, and the turn goes on. A transport failure, the abort of
the turn, an interrupt and the SDK's special protocol errors still throw and end
the call. In a new tool, return a refusal that the model can act on as a tool
result; throw only for a real failure.

For an internal failure the model gets fixed text (`clientSafeToolErrorMessage`
in `lib/tool-call-error.ts`). Only the log keeps the cause. `toolErrorForLog`
writes the type, message, stack, code and cause chain, and applies the
`redactSecrets()` text rules to the message and the stack, and removes URL
user information from logged text. It does not write other fields of the
error, because SDK errors keep request headers and client objects there.

## Add a core managed tool

1. In `services/managed-tools/`, export a catalog array (`name`, `description`,
   `readOnly`, optional `requiresUserApproval`, `inputSchema`) and a factory
   `create<Name>Tools(deps): ManagedToolDefinition[]`. The handler takes tenant,
   user and session from `context`, never from its arguments ([identity
   invariant](../security.md#identity)).
2. Register both in `register-builtin-managed-tools.ts`:
   `catalog.register(asCatalogEntries(CATALOG, true, "<domain>"))` and
   `factoryRegistry.register("<domain>", factory)`, in the place that keeps the
   `tools/list` order in its header comment. The catalog category must equal the
   factory domain key: Policy Center checks the category in the graph and the
   domain key at the gateway (`catalog.ts`). If they differ, a
   `require_approval` rule on that category never prompts and the gateway
   rejects the call. Do not change a domain key after release.
3. `tenantConfigurable` is `true` only for tools that Admin > Agent behavior
   turns on (`enabled_tool_ids`). Tools of an integration (its `readToolIds` and
   `writeToolIds`) use `false`: they run only when the tenant enabled the
   integration and its `connectionProbe` reports a live connection
   (`app-dependencies.test.ts` checks this).
4. Decide the default of a tenant-configurable tool: add it to
   `DEFAULT_TENANT_TOOL_IDS` (on for a new tenant) or to
   `OFF_BY_DEFAULT_TENANT_TOOL_IDS` with the reason
   (`services/tenant-settings-store.ts`). `services/tenant-tool-defaults.test.ts` fails
   for a catalog tool in neither list. These lists apply only to new tenants:
   an existing tenant keeps its stored `enabled_tool_ids`, and the gateway
   leaves the tool out until an admin turns it on. To turn it on for existing
   tenants, add a reviewed backfill migration that adds the id to stored lists
   (examples: migrations `024`, `028`); do not change the stored list of a
   tenant that turned a related tool off.
5. Add new dependencies to the factory deps in `factory.ts`. Test the module in
   a sibling `*.test.ts` and the registration in `factory.test.ts`.

## Member credentials

- An admin chooses per proxy MCP server: one organization credential, or one
  credential per member. Members save bearer tokens, header secrets or query
  secrets in Settings > Connected accounts (`/settings/connections`; API
  `routes/member-mcp.ts`: `GET /me/mcp-connections`, `PUT` and `DELETE
  /me/mcp-connections/:serverId/credentials`). The optional account label is not
  verified. This flow registers no URL and runs no OAuth.
- `member_mcp_credentials` (migration `053`) stores credentials encrypted by
  tenant, member and connection. Saves compare connection and credential
  versions; removal keeps a versioned tombstone.
- An endpoint, authentication or credential-scope change replaces the
  connection's credential binding; members must reconnect.
- An organization secret stays bound to the origin of the upstream URL and to
  the auth method (type and header or parameter name) that it was saved with.
  An edit that changes either, with a blank secret, answers 400
  (`MCP_SECRET_REENTRY_MESSAGE` in `services/mcp-server-store.ts`); the admin
  form asks for the secret again (`mustReenterMcpSecret`). A new path on the
  same origin keeps the secret.
- A runtime call uses the acting member's credential. Project access never lends
  another member's credential. The capability picker shows a personal
  connector before sign-in if the member can connect to it. Runtime tools
  require a current credential. For a legacy ID shared by two rows, the
  member credential store binds to the tenant copy. If that copy is off or
  hidden from the member, the picker omits the inherited personal connector.
- A project chat gets no per-member server and no integration tool that uses a
  personal connection, also with the acting member's own credential. The
  gateway refuses them for a session in a project
  ([project chats and personal data](projects-and-files.md#project-chats-and-personal-data)).
- Tool metadata caches key on member and credential version. The turn's tool
  context records connection hashes and credential versions, so a pending
  approval cannot run through a changed endpoint or a newly saved account.
- Audit events hold ids and versions, never secrets or account labels.

## Personal connections after a security change

A personal connection (GitHub, Notion, Jira, Microsoft 365 from the overlay, or
a saved MCP credential) acts as its owner. A stolen access token could connect
the attacker's account, so:

- Each connection stores `owner_security_version` (migration `083`; null for
  WorkOS sessions). The signed OAuth state carries the version (`sv`); the
  callback refuses with `session_changed` when it is no longer current.
- `ownerSecurityVersionSql` (`services/auth/security-change.ts`) is the one
  check: a store does not return a connection for use when the version differs.
  The connection is suspended, not deleted.
- The owner can confirm a GitHub connection, a Microsoft 365 connection (`POST
  /me/microsoft-connection/confirm`, with the account the page shows), or a
  Notion connection with a provider-attested email. Jira and MCP credentials
  have no confirm. MCP credential owners save credentials again or remove
  them. Jira authorization and site selection are temporarily disabled;
  suspended Jira connections stay suspended. Existing active connections
  can still read Jira and be removed. See the
  [Jira connection restriction](../connectors.md#github-notion-and-jira).
- OAuth callbacks (GitHub, Notion) are bound to the browser that started the
  connect: an httpOnly nonce cookie on the callback path, whose SHA-256 is in
  the signed state.

## Integrations registry

`tenant_integrations` and `IntegrationRegistry`
(`services/integrations/integration-registry.ts`) record which integrations a
tenant enabled. `routes/admin/admin-integrations-routes.ts` manages them. When
integration tools are available: [overlays](../overlays.md#managed-tools).
