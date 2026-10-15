# Interactive UI in chat

Agents can display generated charts, diagrams, calculators, and tables inside
chat. This implements the completed-widget approach described by
[Open Intelligent UI](https://github.com/CopilotKit/OpenIntelligentUI), using
Cogniplane's existing Deep Agents runtime and MCP Apps host.

## Enable the feature

1. Run the database migrations. Migration `063_interactive_ui_skill.sql` adds
   the built-in **Interactive UI** skill. Migration `069_interactive_ui_skill_draft.sql`
   adds a new revision of its text, for the draft flow in
   [Messages from a widget](#messages-from-a-widget).
2. In **Admin → Agent behavior**, enable the `render_interactive_ui` managed tool.
   Keep the **Managed session context** MCP server enabled. The migration does
   not change existing tenant tool permissions.
3. Make the **Interactive UI** skill available to the session. A session with a
   restricted capability selection must include the skill and managed server.
4. Configure the existing MCP Apps sandbox origin. Build the frontend with
   `NEXT_PUBLIC_MCP_APP_SANDBOX_ORIGIN` pointing to a dedicated origin. On that
   origin, serve `/mcp-app-sandbox.html` with `MCP_APP_PARENT_ORIGIN` set to the
   frontend origin. The repository includes the
   [sandbox route](../apps/frontend/src/app/mcp-app-sandbox.html/route.ts).

Use the tenant's existing model credentials. This feature needs no additional
model key, MCP service, or CopilotRuntime endpoint. It uses no external browser
libraries. Provider support does not guarantee that every model can generate
working JavaScript. Test the models you plan to offer.

## Use it

Select an authorized project file and ask, for example:

> Compare spending by category. Show an interactive chart with a category filter
> and summarize the largest expense.

The agent reads the data through its authorized tools and calls
`render_interactive_ui` with a title, a text summary, and an HTML fragment. The
widget appears after the tool completes. It does not stream while the model
writes it. Saved tool input restores the widget after a session reload.

The host adds the title, summary, and theme styles. Widget authors can use
`--background`, `--foreground`, `--muted`, `--border`, and `--primary` CSS variables.
HTML may include inline CSS, SVG, canvas, and JavaScript. Keep fragments below
20,000 characters when possible; the tool rejects more than 64,000 characters.

`window.cogniplane.sendMessage(text)` asks the host to put text in the chat
message box. It returns a Promise. See [Messages from a widget](#messages-from-a-widget).
The widget must handle an `isError` response and allow a retry.

## Messages from a widget

A widget cannot send a message and cannot start an agent turn. A `ui/message`
request (the MCP Apps request behind `sendMessage`) puts its text in the normal
chat message box as an editable draft. The user reads the draft, changes it if
needed, and sends it with the normal Send button.

What the user sees:

- A notice above the message box. It names the source (the tool name and the
  resource URI of the widget), and shows the number of characters and lines.
- A warning in the notice for each of these, when the text has it:
  - control characters (C0, DEL, and C1, but not tab or line breaks),
  - bidirectional control characters (U+202A to U+202E and U+2066 to U+2069),
  - blank lines at the start of the text,
  - a run of three or more blank lines inside the text. Text after a run like
    this can be out of view.
- The host only reports these. It does not remove or change any character. The
  notice reads the box as it is now, so a warning goes away when the user
  removes the cause.
- A **Clear draft** button. The notice goes away when the box is empty, which
  includes a send.

What is sent:

- The chat sends the text that the box holds, with blank space removed at the
  start and end, as it does for every message. The text that the user edited is
  the text that is sent.
- Nothing starts by itself. The host does not send, does not move focus to the
  box, and does not run the agent. Normal tool approvals and Policy Center rules
  apply to the turn that follows, as for any message.

What the host accepts:

- One text block from the `user` role. The limit is 4,000 characters. A longer
  text is refused, and the frame shows an error with the length and the limit.
- A request only while the user can edit the chat, the history is shown, and no
  turn runs. A read-only or busy session refuses it. The text is not kept.
- A request while the box already holds text. The host never replaces or
  changes that text. It does not use the box. The frame shows **Add after my
  draft** and **Dismiss**, with the length of the text but not the text. **Add**
  puts the widget text after the draft of the user, after a blank line, and the
  notice shows. **Dismiss** drops the text. One request can wait for each widget.

The Promise resolves with `{}` when the draft is in the box. It resolves with
`{ isError: true }` when it is not: the request was refused, the user dismissed
it, or the view went away. It never says whether the user edits, sends, or
clears the draft. A widget can have one request at a time. The limit is
`MCP_APP_MESSAGE_MAX_CHARS` in `@cogniplane/shared-types`. The host, the built-in
widget shell, the `render_interactive_ui` tool description, and the text of the
Interactive UI skill all use that value. If you change it, add a migration with a
new skill revision, as migration `069_interactive_ui_skill_draft.sql` does.

The draft reaches the box through the composer slot in
[`copilot-chat-host.tsx`](../apps/frontend/src/components/copilot-chat-host.tsx).
`CopilotChat` owns the text of the box and gives the slot a `value` and an
`onChange`. [`widget-draft.tsx`](../apps/frontend/src/components/widget-draft.tsx)
binds them, so a widget reaches the box through the public slot props and no
internals of CopilotKit. The rules (limit, checks, warnings) are in
[`widget-draft.logic.ts`](../apps/frontend/src/components/widget-draft.logic.ts)
and [`mcp-app-frame.logic.ts`](../apps/frontend/src/components/mcp-app-frame.logic.ts).

## Access and isolation

The existing MCP gateway binds the tool call to its tenant and session and
applies tool enablement, approval, and Policy Center rules. When a user reopens a
widget, the backend checks session read access, current server selection, tool
enablement, the declared resource URI, and current Policy Center rules. A newly
disabled tool or blocked policy prevents access to saved widgets.

Generated code runs in the existing opaque-origin inner iframe. The host permits
inline scripts and applies its restrictive content security policy. Widgets have
no application credentials, browser storage, external resource loading, network
access, form submission, browser dialogs, or `eval`. Widget code cannot approve
actions or directly invoke backend tools. Secret redaction also applies to saved
widget input and results.

The host, the sandbox page, and the widget exchange messages with `postMessage`.
Each hop checks the sender and the target:

- Host to sandbox page. The host uses `OriginBoundPostMessageTransport`
  ([`mcp-app-origin-transport.ts`](../apps/frontend/src/lib/mcp-app-origin-transport.ts)).
  It reads a message only when `event.source` is the window of the sandbox frame
  and `event.origin` is the sandbox origin. It sends only to that exact origin,
  never to `"*"`. The library class has no public hook for the origin check, so
  the transport wraps a private field. If a library update moves that field, the
  constructor throws, the frame shows an error, and the bridge does not run
  without the check.
- Sandbox page to host. The page
  ([`mcp-app-sandbox-html.ts`](../apps/frontend/src/lib/mcp-app-sandbox-html.ts))
  reads a message from its parent window only when `event.origin` equals
  `MCP_APP_PARENT_ORIGIN`, and it sends to the parent only at that origin. A
  value that is not a plain origin, or no value, makes the page stop at start.
- Sandbox page to widget. The inner frame has an opaque origin, so only `"*"`
  can address it. The page uses `"*"` only toward that inner frame, and reads
  from it only when `event.source` is that frame window. The page does not pass
  `ui/notifications/sandbox-*` messages between the two sides.

Before loading the widget, the sandbox also sets an outer frame policy that
blocks navigation of the widget's iframe. Generated widgets declare no frame
domains. Proxy MCP Apps retain their declared frame-domain permissions.

Widgets have local state. Reload rebuilds them from the original input; changes
to sliders or filters do not persist. Calculations and generated code still need
verification before users rely on their results. The agent should also give a
text answer that remains useful when the sandbox is unavailable.

Ordinary HTML artifact previews keep scripts disabled. A downloadable artifact
and an interactive chat widget use different preview paths.

## Supported resource contract

The host renders `tool_mcp_app` events during a turn and saved `ToolResult.mcpApp`
records after reload. A managed tool declares its resource in the trusted tool
catalog. A proxy MCP tool declares `_meta.ui.resourceUri` and serves that resource
through `resources/read`. A `ui://` URI alone does not enable rendering.

The gateway attaches the declared resource URI to the result. The backend saves
the app input and result before the live widget event becomes available. The host
loads HTML through `GET /sessions/:sessionId/mcp-apps/:toolCallId`, which checks
current access and policy. Proxy resources can declare CSP domains. Built-in
generated widgets declare none.

A declaration is input from the MCP server. It does not grant anything. An
administrator approves each domain for one source list (scripts and images,
network requests, frames, or base URL) of one server, in **Admin → MCP
connections**. The backend gives the widget only the declared domains that are
approved for that server and that list. The sandbox page checks the same limit
again before it builds the policy. A new tenant, and a server that nobody has
configured, start with no approved domain. A widget then has no outside
resource, connection, frame, or base URL until an administrator approves one.

The admin page lists the domains that a server's widgets asked for. The list
fills when a member opens a widget. An administrator can also approve a domain
before a widget asks for it. The rules for a domain are the same for the admin
input, the backend, and the sandbox. A domain is `https://` and a host name,
with an optional port. A secure web socket (`wss://`) is allowed for network
requests only. A wildcard can only start the name (`https://*.example.com`),
matches subdomains at any depth, and does not match the name itself. A wildcard
on a public suffix, such as `*.com`, `*.co.uk`, or `*.github.io`, is not
allowed. A wildcard on a name whose children are public suffixes, such as
`*.kobe.jp`, is not allowed either. The check uses the public suffix list in the `tldts` package, including
its private section. These are not allowed: IP addresses, `localhost`, special-use
and local names (`.local`, `.internal`, `.test`, and others), user names, paths,
queries, and any space, quote, semicolon, or comma. The rules check the text of
a source. They do not check the address that a host name resolves to, so a name
that resolves to a private address still passes. The sandbox page has no public
suffix list. It relies on the backend, which checks each approval against the
list before it saves it.

Generic inline `resource` blocks in tool results are unsupported as widgets.
The backend does not send an event for them and does not save them. If a result
has no other text, the tool card names each embedded resource by URI and MIME
type, live and after reload. It never shows the resource body. This applies to
blocks in the raw MCP content and to blocks that the LangChain MCP adapter moves
to the tool message artifact. This text goes to the tool card and the saved
transcript only. The model receives the adapter's tool message unchanged.

Rows that earlier versions saved can still contain `ToolResult.uiResources`.
History reads return the field, and a later update to the same row keeps it. The
frontend does not render it. No migration removes or backfills these rows, and
the host has no inline HTML renderer.
