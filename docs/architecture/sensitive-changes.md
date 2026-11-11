# Sensitive changes

Scope: step-up, data routes, weaker controls, skill releases and owner notices:
the controls that limit what a stolen owner or admin token can change. Sign-in
and accounts are in [auth](auth.md) and [local accounts](local-accounts.md).

## Step-up

- `POST /auth/step-up` (password or second factor) and the passkey variant issue
  a single-use token (`STEP_UP_TTL_SECONDS`, code constant) bound to user,
  tenant, sign-in session, security version and one action
  (`services/auth/step-up-store.ts`). A sign-out ends it.
- When the account has a second factor, step-up must use it; a password alone
  returns `403 strong_step_up_required`.
- `services/auth/step-up-routes.ts` lists every route that needs step-up;
  `routes/step-up-routes.test.ts` fails CI for a route of the covered plugins
  that is in neither its step-up list nor its exempt list. A refusal is 403 with
  `{ error, action }`. The frontend (`lib/api-client.ts`,
  `components/step-up-host.tsx`) shows one dialog and resends the request once
  with `X-Step-Up`.
- The actions are the keys of `STEP_UP_ROUTES`
  (`services/auth/step-up-routes.ts`): account and factor changes, manager
  actions on a local member, the MFA policy, the [data routes](#data-routes),
  [weaker controls and skill releases](#weaker-controls-and-skill-releases), and
  the marketplace setting. The comments in that file give each condition; for
  example, a password change needs step-up only when the account has a second
  factor.
- A WorkOS session never needs step-up: Cogniplane cannot ask WorkOS for a fresh
  proof. The owner notice is the check for WorkOS tenants.

## Data routes

A data route changes where tenant data goes. Each data route calls
`DataRouteControl.requireStepUp` (`services/data-route-control.ts`) after input
checks and before the change:

- The data routes are the entries under the "Data routes" comment of
  `STEP_UP_ROUTES` (`services/auth/step-up-routes.ts`): for example the provider
  API key, the tenant settings save, MCP server changes and integration
  settings. Overlays use `requireStepUpForOverlay` with an action from
  `OVERLAY_STEP_UP_ACTIONS`.
- Every change, from every session type, queues an [owner
  notice](#owner-notices).
- A tenant settings save or integration save needs step-up only when it changes
  a protected field. `routes/admin/data-route-fields.ts` is the one list of
  protected fields (`kind: "data_route"` or `"control"`).
- A save that lacks the proof its session type needs never writes a protected
  field.
- The integration route writes only the keys that differ, onto the row it locks
  (`IntegrationStateStore.applyChanges`).
- Checks that cannot spend a token run first: a missing MCP server answers 404,
  and an MCP connection edit from an older version answers 409
  `mcp_server_conflict`, before the step-up check.
- Data routes outside `/admin/` use the admin rate limit (`admin_query`).

## Weaker controls and skill releases

The same step-up and owner notice protect a change that weakens a control for
every user, and every skill release:

- Policy Center rules: needed only for a weaker change, where one tool call gets
  a less strict outcome (`allow` < `require_approval` < `block`) in any mode.
  `services/policy/policy-weakening.ts` runs the real engine before and after on
  sample actions. Above `MAX_WORK` it fails closed (counts as weaker).
- PII settings (`PUT /tenant/settings/pii`): needed only for a weaker save, as
  `services/pii/pii-weakening.ts` decides (for example protection off or a lower
  mode).
- Both classify inside the write transaction, against locked rows
  (`DataRouteControl.writeWithStepUpIfWeaker`): the store refuses a weaker
  change without step-up (`WeakerChangeError`) and rolls back; the route then
  asks for step-up and writes again. Revision and order conflicts (409) and
  missing rules (404) answer before a token is spent.
- Skill releases always need step-up and notify owners: revision activation,
  publish to all members, release of a submitted skill, release of a project
  skill. A personal skill release does not; it runs only for its owner.
- Setting a skill marketplace address needs step-up; removing it does not.

## Owner notices

- `services/mail/setting-change-notices.ts` queues `tenant_setting_changed` for
  each data-route change, weaker change, skill release and tenant rename, to
  every owner with an address, local or WorkOS, through the [email
  outbox](email.md). The notice is written in the transaction of the change's
  audit event, so it exists only if the change commits.
- Fixed subject. It names who, which setting and object, which fields, and when;
  never a value (key, address, secret). Names that people choose appear only in
  labelled fields, next to the immutable organization id.
- At most one notice per owner per `OWNER_NOTICE_WINDOW_MINUTES` (code
  constant); later changes join one follow-up. A notice that reaches no owner
  logs a warning.
- With email off, the audit event is the only record.
