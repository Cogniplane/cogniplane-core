# MCP Apps and interactive widgets

Scope: widgets that run HTML and JavaScript in a sandboxed frame: the managed
`render_interactive_ui` tool and proxy MCP tools that declare an MCP App
resource. Catalog components without code (`render_ui`) are in [chat
UI](chat-ui.md).

## Enable `render_interactive_ui`

1. Run migrations; they add the built-in Interactive UI skill.
2. In Admin > Agent behavior, enable the `render_interactive_ui` managed tool
   and keep the "Managed session context" MCP server enabled. Migrations do not
   change tenant tool permissions.
3. Make the Interactive UI skill available to the session.
4. Serve the sandbox page on a dedicated origin, with `MCP_APP_PARENT_ORIGIN`
   set to the frontend origin. Either the Next.js route
   (`apps/frontend/src/app/mcp-app-sandbox.html/route.ts`) on a second
   deployment, or the Worker (`apps/frontend/sandbox-worker/`): deploy it with
   `pnpm --filter @cogniplane/frontend exec wrangler deploy --config
   wrangler.sandbox.jsonc` and set the Worker's `MCP_APP_PARENT_ORIGIN` var.
5. Build the frontend with `NEXT_PUBLIC_MCP_APP_SANDBOX_ORIGIN` set to that
   origin. `docker/frontend.Dockerfile` has no build argument for it: add one
   (`ARG` and `ENV` before the build step, like `NEXT_PUBLIC_API_URL`), or build
   with `cf:build`.

No extra model key or service is needed. Not every model writes working
JavaScript: ask each model you enable for a small widget before you offer it.

## Tool contract

- Input: title, text summary, HTML fragment (inline CSS, SVG, canvas and
  JavaScript allowed), at most `MAX_INTERACTIVE_UI_HTML_LENGTH` characters
  (`services/managed-tools/interactive-ui.ts`).
- The widget appears after the tool completes; it does not stream. A reload
  rebuilds it from the saved input. Widget state (sliders, filters) is not
  saved.
- Theme variables: listed in the tool description in
  `services/managed-tools/interactive-ui.ts`.
- The agent must also give a text answer that works without the widget.

## Resource contract

- During a turn the host renders `tool_mcp_app` events; after a reload it
  renders saved `ToolResult.mcpApp`.
- A managed tool declares its resource in the trusted catalog. A proxy tool
  declares `_meta.ui.resourceUri` and serves it through `resources/read`. A
  `ui://` URI alone enables nothing.
- The backend saves app input and result before the live event. The host loads
  HTML through `GET /sessions/:sessionId/mcp-apps/:toolCallId`, which rechecks
  session read access, server selection, tool enablement, the declared URI and
  current Policy Center rules. A newly disabled tool or blocking rule also hides
  saved widgets.
- Generic inline `resource` blocks are not widgets. The backend neither emits
  nor saves them; the tool card names each by URI and MIME type only.
- Old rows can hold `ToolResult.uiResources`. History returns the field; nothing
  renders it. Do not add a renderer that skips the resource route's checks.

## Isolation

- Widget code runs in an opaque-origin inner iframe with a restrictive CSP: no
  app credentials, storage, forms, dialogs or `eval`. Widgets cannot approve
  actions or call backend tools.
- Network and external resources: none for `render_interactive_ui` widgets; for
  a proxy MCP App, only the domains that an admin approved for that server
  ([Proxy widget domains](#proxy-widget-domains)). Saved widget input and
  results are redacted.
- `postMessage` checks at each hop:
  - Host to sandbox page: `OriginBoundPostMessageTransport`
    (`lib/mcp-app-origin-transport.ts`) accepts only the sandbox frame window
    and origin and never sends to `"*"`. It wraps a private library field; if a
    library update moves it, the constructor throws and the bridge does not run.
  - Sandbox page to host (`lib/mcp-app-sandbox-html.ts`): only
    `MCP_APP_PARENT_ORIGIN`; an invalid or missing value stops the page.
  - Sandbox page to widget: `"*"` only toward the inner frame, reading only from
    that frame window.
- The sandbox page sets `frame-src` for the widget frame to the server's
  approved frame domains, or `'none'` when there are none
  (`lib/mcp-app-sandbox-html.ts`). The widget cannot navigate elsewhere.
- Ordinary HTML artifact previews keep scripts disabled; they use a different
  path.

### Proxy widget domains

- A proxy server's CSP domain declarations grant nothing. An admin approves each
  domain per server and per source list (scripts and images, connections,
  frames, base URL) in Admin > Connections. New tenants and servers start with
  none.
- Domain rules (`csp-sources.ts` in shared-types; the backend enforces all of
  them when it saves and when it sends a source):
  - `https://` and a host name, with an optional port. `wss://` only for
    connections.
  - A leading wildcard matches subdomains only. No wildcard on a public suffix,
    or on a name whose children are public suffixes (`tldts` list, private
    section included; backend only, `isRegistrableWildcardParent`). The sandbox
    page keeps a copy of the other rules (`lib/mcp-app-sandbox-html.ts`) and
    gives a widget only sources that it declared and the backend approved.
  - Refused: IP addresses, `localhost`, special-use names, user info, paths,
    queries, spaces, quotes, semicolons, commas.
  - The rules check text, not DNS results.
- Approving a domain is a [data route](sensitive-changes.md#data-routes).

## Messages from a widget

`window.cogniplane.sendMessage(text)` (MCP Apps `ui/message`) never sends a
message or starts a turn. It puts an editable draft in the message box; the user
sends it with Send.

- Accepted: one `user` text block of at most `MCP_APP_MESSAGE_MAX_CHARS`
  (`packages/shared-types/src/schemas/message.ts`), only while the user can edit
  and no turn runs. One request per widget at a time.
- The host never changes text that the user typed; the user chooses to append or
  dismiss.
- A notice names the source widget and warns about hidden or misleading
  characters; it removes nothing.
- The Promise resolves `{}` when the draft is placed and `{ isError: true }`
  otherwise; widgets must handle `isError`.
- Code: `components/widget-draft.tsx` binds CopilotChat's public composer slot;
  rules are in `widget-draft.logic.ts` and `mcp-app-frame.logic.ts`.
- If you change `MCP_APP_MESSAGE_MAX_CHARS`, add a migration with a new
  Interactive UI skill revision (as `069` does), because the skill text states
  the limit.
