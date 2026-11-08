# Connectors

Scope: operator setup of the bundled connectors (GitHub, Notion, Jira, Microsoft
365) and of proxy MCP servers. To build a new connector, see
[overlays](overlays.md).

## GitHub, Notion and Jira

| Connector | Backend variables | Redirect URI to register | Members |
|---|---|---|---|
| GitHub (OAuth App) | `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `GITHUB_OAUTH_REDIRECT_URI` | `https://<backend>/auth/github/user/callback` | Connect in Settings > Connected accounts |
| Notion | `NOTION_OAUTH_CLIENT_ID`, `NOTION_OAUTH_CLIENT_SECRET`, `NOTION_OAUTH_REDIRECT_URI` | `https://<backend>/integrations/notion/callback` | Connect in Settings > Connected accounts |
| Jira Cloud (Pipedream Connect, read-only) | `PIPEDREAM_CLIENT_ID`, `PIPEDREAM_CLIENT_SECRET`, `PIPEDREAM_PROJECT_ID`, `PIPEDREAM_PROJECT_ENVIRONMENT` | None (Pipedream hosts the OAuth flow) | Connect a Jira account through Pipedream and pick one site |

Each group of client id, secret and redirect URI (or project id) is
all-or-nothing ([startup rules](configuration.md#startup-rules)). Set
`PIPEDREAM_PROJECT_ENVIRONMENT=production` for a production Pipedream project.
Then an admin enables the connector for the tenant in Admin > Connections.
Without the variables, the connector shows "not configured".

GitHub tools work only on repositories that the member allows on the page
Settings > GitHub (API `PUT /me/github-connection/repositories`, at most
`GITHUB_ALLOWED_REPOSITORY_LIMIT`). A new connection allows none, and a
reconnect with another GitHub account clears the list
(`github-repository-allowlist.ts`, `github-tools.ts`).

## Microsoft 365 (SharePoint overlay)

The bundled Microsoft 365 overlay (`private/sharepoint-overlay-backend`,
`-frontend`, `-contracts`) adds SharePoint and OneDrive read tools (list sites,
browse, search, read, import into a session) and write tools (upload, create
folder). A member's sign-in asks for `Files.Read.All` and `Sites.Read.All`, or
`Files.ReadWrite.All` and `Sites.ReadWrite.All` when the tenant turned on writes
for Microsoft 365. A member who connected before writes were turned on
reconnects; until then the write tools refuse with a reconnect message
(`hasMicrosoftWriteScope`).

1. Register an app in Microsoft Entra ID. Add the redirect URI
   `https://<backend>/integrations/microsoft/callback`, and the delegated
   permissions `User.Read`, `offline_access` and either the two read scopes or
   (for writes) the two ReadWrite scopes
   (`private/sharepoint-overlay-backend/src/services/microsoft-connection-service.ts`).
2. Set `MICROSOFT_OAUTH_REDIRECT_URI` to that URI on the backend. Without it,
   the integration reports "not configured".
3. In Admin > Connections, enable Microsoft 365 and enter the client id, client
   secret (stored encrypted) and directory (tenant) id. This is a [data
   route](architecture/sensitive-changes.md#data-routes).
4. Each member connects their account in Settings > Microsoft 365
   (`/settings/microsoft`).

Imported files pass the overlay's PII import scope (`microsoftImports`).

## Proxy MCP servers

Admin > Connections > Add connection (`POST /admin/mcp-servers/setup`, step-up
required). Gateway rules: [tools](architecture/tools.md#mcp-gateway).

1. Set mode `proxy`, the upstream URL (no credentials in the URL; [outbound
   rules](security.md#outbound-requests)), the upstream authentication (`none`,
   `bearer`, `header`, `query`) and the credential scope (`organization`: one
   saved secret; `personal`: each member saves one, see [member
   credentials](architecture/tools.md#member-credentials)). Set the audience:
   - `off`: the server is disabled;
   - `test_users`: enabled, not published; only test users see it;
   - `members`: enabled and published for every member.

   An admin makes a member a test user in Admin > People (`POST
   /admin/users/:userId/set-beta-tester`, `{ isBetaTester }`, audited).
   Unpublished skills use the same rule (`DynamicConfigService`).
2. Give the upstream its signing key if it verifies requests ([MCP proxy
   signature](mcp-proxy-signature.md#get-an-upstream-key)).
3. Run the connection test ([tools](architecture/tools.md#mcp-gateway)).
4. As a member: save a credential if the scope is `personal`, then check that
   the connector shows in a chat's capability picker and that one tool call
   works.
