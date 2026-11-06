import type { StepUpAction } from "./step-up-store.js";

// The routes that need step-up (docs/ARCHITECTURE.md, "Authentication"):
// every route that grants a sign-in credential, a Cogniplane account, or a
// tenant role, or ends an account or a factor, every tenant setting that
// changes where the tenant's data goes (data routes, below), every change
// that makes a control weaker for every user (Policy Center rules, PII
// protection), and every skill release. An access token alone must not do
// these things. A stolen token can be used until it expires, but what it
// creates (an account, a factor, a role, a new data destination, a weaker
// control, a released skill) stays after the victim changes the password or
// signs out everywhere. Other things that a session creates (scheduled jobs,
// external connections) are tracked in bead q4w0.8.
//
// Each route gives its own key to requireStepUp (a data route: to
// DataRouteControl.requireStepUp), which consumes a step-up token for the
// action here. routes/step-up-routes.test.ts sends every key a request with
// only an access token, through the real auth, tenant, admin, skill
// submission, and project skill route plugins. It also lists every other
// route of those plugins with the reason it needs no step-up. So a new route
// in those plugins fails CI until it is put in one of the two lists.
//
// Some routes need step-up only in one case. The test sets up that case:
// - POST /me/security/password: when the account has a second factor.
//   Without one, the current password in the body is the proof.
// - PUT /tenant/members/:userId/role and DELETE /tenant/members/:userId: when
//   the target is a local account (the target's login path decides, not the
//   caller's session). A WorkOS member needs none: WorkOS owns that sign-in.
// - PUT /tenant/settings/security: when the rule becomes weaker.
// - Data routes: when the caller's session is local. A WorkOS session gives
//   no step-up (WorkOS owns that sign-in), and dev-headers mode has no
//   sessions. Every change of a data route also emails all tenant owners.
// - PUT /admin/tenant-settings: when a field that routes data or a control
//   changes (routes/admin/data-route-fields.ts). PUT
//   /admin/integrations/:integrationId: when a setting changes or reads or
//   writes turn on. Other saves need neither step-up nor a notice.
// - The Policy Center rule routes: when the change makes the policy weaker
//   (services/policy/policy-weakening.ts). PUT /tenant/settings/pii: when the
//   save makes PII protection weaker (services/pii/pii-weakening.ts). Both
//   classify the change in the write's transaction, against the locked data
//   (DataRouteControl.writeWithStepUpIfWeaker).
// - PUT /tenant/settings/marketplace: when the save sets an address.
//   Removing the address needs neither step-up nor a notice.
// - POST /projects/:projectId/skills/:skillId/action: when the action is
//   "release". Turning the skill off needs neither.
//
// The rule is the route, not the audience or the registrations of the
// moment: every route and every stored key that can make a change live is
// protected. A project skill release needs step-up even in a project that
// nobody else uses yet, because sharing the project later gives its released
// skills to the new members.

export const STEP_UP_ROUTES = {
  "POST /tenant/members": "member.create",
  "PUT /tenant/members/:userId/role": "member.role_change",
  "POST /tenant/members/:userId/password-reset": "member.password_reset",
  "POST /tenant/members/:userId/disable": "member.disable",
  "POST /tenant/members/:userId/enable": "member.enable",
  "DELETE /tenant/members/:userId": "member.remove",
  "POST /tenant/members/:userId/mfa-reset": "member.mfa_reset",
  "PUT /tenant/settings/security": "tenant.mfa_policy",
  "POST /me/security/password": "self.password_change",
  "POST /me/security/totp/start": "self.totp_replace",
  "DELETE /me/security/totp": "self.totp_remove",
  "POST /me/security/recovery-codes": "self.recovery_codes",
  "POST /me/security/passkeys/options": "self.passkey_add",
  "DELETE /me/security/passkeys/:credentialId": "self.passkey_remove",
  // Data routes: a provider key, a tenant settings save (enabled providers
  // and models, the default model, sandbox network hosts, enabled MCP
  // servers and tools, agent instructions), an MCP server's address and
  // secret, which members use a shared server, an approved widget domain,
  // and an integration's settings.
  "PUT /tenant/settings": "tenant.provider_key",
  "PUT /admin/tenant-settings": "tenant.settings",
  "POST /admin/mcp-servers": "mcp_server.create",
  "PUT /admin/mcp-servers/:serverId": "mcp_server.update",
  "POST /admin/mcp-servers/setup": "mcp_server.setup_create",
  "PUT /admin/mcp-servers/:serverId/setup": "mcp_server.setup_update",
  "PUT /admin/mcp-servers/:serverId/inherited-availability": "mcp_server.inherited_audience",
  "POST /admin/mcp-servers/:serverId/widget-domains/approve": "mcp_server.widget_domain",
  "PUT /admin/integrations/:integrationId": "integration.update",
  // Changes that can make a control weaker for every user: Policy Center
  // rules and PII protection.
  "POST /admin/policy/rules": "policy.rule_create",
  "PATCH /admin/policy/rules/:ruleId": "policy.rule_update",
  "DELETE /admin/policy/rules/:ruleId": "policy.rule_delete",
  "PUT /admin/policy/rules/order": "policy.rule_order",
  "PUT /tenant/settings/pii": "tenant.pii_settings",
  // Skills: where they are imported from, and the release that gives their
  // instructions to users' agents.
  "PUT /tenant/settings/marketplace": "tenant.skill_marketplace",
  "POST /admin/skills/:skillId/revisions/:skillRevisionId/activate": "skill.revision_activate",
  "POST /admin/skills/:skillId/publish": "skill.publish",
  "POST /admin/skill-submissions/:id/release": "skill.submission_release",
  "POST /projects/:projectId/skills/:skillId/action": "skill.project_release"
} as const satisfies Record<string, StepUpAction>;

/**
 * Data-route actions with no route in the core: an optional overlay gives
 * each one to one of its routes (DataRouteControl.requireStepUpForOverlay),
 * and the overlay's own test checks that route. The core cannot name an
 * overlay's route: the public tree has no overlay.
 */
export const OVERLAY_STEP_UP_ACTIONS = ["integration.overlay_settings"] as const satisfies readonly StepUpAction[];
export type OverlayStepUpAction = (typeof OVERLAY_STEP_UP_ACTIONS)[number];

/** A route that needs step-up, as `METHOD /path` with the path's parameters. */
export type StepUpRoute = keyof typeof STEP_UP_ROUTES;
