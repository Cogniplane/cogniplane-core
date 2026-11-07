# Frontend

Scope: structure of the Next.js app (`apps/frontend`) outside the chat: routes,
providers, API clients, data fetching, overlays and builds. The chat is in [chat
UI](chat-ui.md). Before you use a Next.js API, read `apps/frontend/AGENTS.md`:
this Next.js version differs from older ones.

## Routes (`src/app/`)

| Route | Purpose |
|---|---|
| `/` | Workspace: session list and chat |
| `/sessions/archived`, `/artifacts`, `/projects` | Archived sessions, files, projects |
| `/settings/*` | Personal settings: overview, chat defaults (`capabilities`), connections, memories, scheduled jobs, security, skill updates, token usage, integration pages |
| `/admin/*` | Owners and admins; the navigation is `app/admin/admin-sections.ts` |
| `/login`, `/auth/*` | Sign-in, WorkOS callback, setup, forgot and reset password |
| `/mcp-app-sandbox.html` | MCP App sandbox page ([MCP Apps](mcp-apps.md)) |

## State and data

- `app/providers.tsx` mounts `AuthProvider` (`lib/auth-context.tsx`, which
  mounts the TanStack Query provider from `lib/query-provider.tsx`) and, inside
  it, `StepUpHost` (the shared step-up dialog) and the toast surface.
- Query keys are in `lib/query-keys.ts`. Invalidate by key prefix so that one
  change refreshes every related query.
- `lib/api-client.ts` holds the access token
  ([auth](auth.md#tokens-and-cookies)), refreshes it, orders session changes,
  and resends a request once after step-up. Per-domain clients are
  `lib/*-api.ts`.
- Parse every response with its shared schema through `parseResponse`
  (`lib/validate-response.ts`); do not cast JSON to a type.
- `AuthGuard` (`lib/auth-guard.tsx`) and `middleware.ts` only control rendering
  and redirects ([security](../security.md#frontend)).

## UI code

- Primitives (shadcn style) are in `components/ui/`; shared class tokens are in
  `lib/ui-tokens.ts`. Visual rules: `apps/frontend/DESIGN.md`; product intent:
  `apps/frontend/PRODUCT.md`.
- Logic that a component needs is in a sibling `*.logic.ts` file with its own
  tests.
- Overlays register frontend parts from `apps/frontend/src/overlays.ts`. See
  [overlays](../overlays.md).

## Add a page

- Core route: a folder under `src/app/` with `page.tsx`. A client page fetches
  with TanStack Query (a key from `lib/query-keys.ts`) through a `lib/*-api.ts`
  client that calls `parseResponse`.
- Admin section: add it to `ADMIN_LIVE_SECTIONS` (`app/admin/admin-sections.ts`)
  and create `app/admin/<id>/page.tsx`. A moved page keeps its old URL in
  `ADMIN_SECTION_ALIASES`.
- Settings section: add it to `settings-sections.ts`; core components go in
  `settings-section-components.ts`. An integration section renders at
  `/settings/<id>` through the `[integrationId]` route.
- Overlay pages: [overlays](../overlays.md).

## Builds and variables

- `next dev` for development (`make dev`).
- `pnpm --filter @cogniplane/frontend cf:build`: Cloudflare Workers build
  (OpenNext). `docker/frontend.Dockerfile`: Node image.
- `NEXT_PUBLIC_*` values are built into the bundle and are public. Set them at
  build time; changing them needs a rebuild.

| Variable | Use |
|---|---|
| `NEXT_PUBLIC_API_URL` | Backend URL |
| `NEXT_PUBLIC_MCP_APP_SANDBOX_ORIGIN`, `MCP_APP_PARENT_ORIGIN` | MCP App sandbox ([MCP Apps](mcp-apps.md#enable-render_interactive_ui)) |
| `NEXT_PUBLIC_DEV_USER_ID`, `NEXT_PUBLIC_DEV_TENANT_ID`, `NEXT_PUBLIC_DEV_AUTH_KEY` | `dev-headers` identity; development only |
| `COGNIPLANE_ALLOW_DEV_AUTH_IN_PRODUCTION_BUILD` | `1` lets a production build keep the dev identity (`next.config.ts` refuses it otherwise); only for the loopback Compose stack |
| `NEXT_PUBLIC_COPILOTKIT_INSPECTOR` | `1` shows the CopilotKit Inspector in local development |
| `NEXT_PUBLIC_BUILD_SHA`, `NEXT_PUBLIC_BUILD_DATE` | Build details shown in the UI (optional) |

The sandbox Worker setup is in [MCP
Apps](mcp-apps.md#enable-render_interactive_ui).
