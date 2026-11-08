# Chat UI

Scope: the browser chat host, generative UI (`render_ui`, A2UI), the side panel,
tool cards, saved drafts, and the development inspector. Widgets that run
generated code (`render_interactive_ui`, MCP Apps) are in [MCP
Apps](mcp-apps.md). The design system is in `apps/frontend/DESIGN.md`; product
principles are in `apps/frontend/PRODUCT.md`.

## Chat host

- CopilotKit renders the chat. `components/copilot-chat-host.tsx` hosts it;
  `lib/agui/deep-agents-browser-agent.ts` (`DeepAgentsBrowserAgent`) connects to
  `POST /messages` and turns the SSE stream into AG-UI events.
- Preserve both paths: live streaming, and reload seeding from saved history
  (`services/agui-history.ts` on the backend). Tests:
  `copilot-chat-host*.test.tsx`, `services/agui-history.test.ts`.
- The host mounts a new provider for each session, so no state crosses sessions.
- Generated UI events and renderer callbacks never start an agent turn. Only the
  user's Send starts a turn.

## Generative UI (`render_ui`)

Standard A2UI v1.0 catalog `cogniplane/standard@1`, rendered by CopilotKit.

- The browser agent builds a tool guide from the current catalog and the mounted
  targets in `GENERATIVE_UI_TARGETS` (`chat`, `side-panel`), and sends it as
  `generativeUiContext` with `generativeUiTransport: "tool"`.
- `POST /messages` bounds the context (`MAX_GENERATIVE_UI_CONTEXT_LENGTH`; this
  and the `MAX_RENDER_UI_*` limits below are in
  `packages/shared-types/src/schemas/message.ts`), checks session access, and
  applies the chat PII policy to it before it saves a prompt or spends quota. A
  block returns 422.
- The runtime adds the context as a user message just before the current prompt,
  for this turn only (`generative-ui-context-middleware.ts`). It is not
  checkpointed. Scheduled turns and subagents get no UI context or UI tool.
- The backend `render_ui` tool exists only on turns that carry the transport
  flag and context. It accepts target `chat` or `side-panel` and at most
  `MAX_RENDER_UI_OPERATIONS` surface operations in `MAX_RENDER_UI_ARGS_CHARS`
  characters. It checks operation shape, catalog id and surface lifecycle:
  create before update or delete; a deleted id cannot return in the same turn; a
  surface keeps the target it was created with. The browser stays authoritative
  for component and prop validation. MCP tools cannot use the name `render_ui`.
- `render-ui-stream.ts` emits cumulative `generative-ui-surface` activity
  snapshots while arguments stream. History rebuilds the same activities from
  saved tool input (`RenderUiTurn`). Surface ids include the assistant reply id.
- Earlier user values go back to the model as read-only records, newest first,
  within `MAX_EARLIER_VALUE_CHARS` per text value and
  `MAX_EARLIER_RECORDS_CHARS` in total
  (`lib/agui/deep-agents-browser-agent.ts`). `previewEarlierRecords` builds
  them, and `generative-ui-input-context.tsx` shows the user what the next
  message sends.
- The catalog (`components/generative-ui-catalog.tsx`) removes model event
  callbacks and Modal `open`/`setOpen`, validates CSS and SVG paint values,
  shows HTML as text, and needs a click for external media.

### Application components

Shared schemas in `packages/shared-types/src/schemas/message.ts` bound every
prop (`CHECKLIST_LIMITS`, `COMPARISON_TABLE_LIMITS`, `STATUS_SUMMARY_LIMITS`);
an invalid prop shows the SDK fallback.

| Component | Behavior |
|---|---|
| `ArtifactCard` | The model sets only `artifactId` (UUID). The card reads name, status and PII label from the session's artifact list, offers Preview only for a ready, allowed file, and cannot download, change or select files. |
| `Checklist` | `checked` and `notes` are writable when bound to data paths. "Use in reply" writes a text summary into the message box and sends nothing. |
| `ComparisonTable` | Shows values as given; no ranking or highlight. |
| `StatusSummary` | Fixed status set; computes no counts or percentages. |

## Side panel

`generative-ui-side-panel.tsx`, target `side-panel`
(`GENERATIVE_UI_PANEL_TARGET`).

- Panel activities stay in the transcript but do not render there. The panel
  shows the newest view; a picker selects earlier views (tab state only).
- CopilotKit renders only the newest surface of a target, so the host moves
  other views to extra targets (`lib/agui/generative-ui-targets.ts`,
  `canonicalTarget`). Read that file before changing panel selection.
- When the newest view failed, the panel says so instead of showing an older
  view.
- A new view opens the panel on wide screens without moving focus. On narrow
  screens the panel is a modal, and a notice offers to open it.

## Saved drafts

`useGenerativeUiDrafts` (`generative-ui-drafts.ts`) keeps user-typed values of
bound props in `sessionStorage`, because a reload rebuilds surfaces from saved
operations only.

- Records are keyed by a hash of the user and tenant ids, apply only to the same
  surface, and are cleared when the signed-in person changes or signs out.

## Tool cards

`copilot-render-slots.tsx`, `tool-activity.logic.ts`,
`chat-cards/tool-approvals.ts`.

- Status comes from the call and its saved outcome. A call with no result before
  the newest prompt is interrupted, never failed: the action may be done, partly
  done or not started.
- Cards render tool input and results as text only (`RESULT_PREVIEW_LIMIT`).
  `render_ui` calls have no card.
- Approval controls appear on the first mounted card of the linked call. The
  notification list shows every other pending approval, including unlinked ones.
  See [approvals](approvals.md#tool-calls-and-approval-cards).

## Development inspector

Rules for the CopilotKit Inspector are in `lib/copilotkit-inspector.ts` (local
development only). Always pass `enableInspector` as a boolean: CopilotKit turns
it on by default in development.
