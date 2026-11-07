// Reviewed exceptions for the full-app census. Enforcement stays in services/auth/step-up-routes.ts.
// Canonical data routes require proof for local sessions. WorkOS changes use
// owner notices until WorkOS can supply fresh proof.
/** Project skill routes that need no step-up, and why. */
const PROJECT_SKILL_NO_STEP_UP: Record<string, string> = {
  "POST /projects/:projectId/skills": "makes a draft; nothing runs for anyone until a release",
  "POST /projects/:projectId/skills/from-personal": "copies the member's own released personal skill as a draft; nothing runs until a release",
  "PUT /projects/:projectId/skills/:skillId": "saves a new draft; the released revision does not change until a release",
  "POST /projects/:projectId/skills/:skillId/from-personal": "saves a new draft from the member's own personal skill; nothing changes until a release",
  "DELETE /projects/:projectId/skills/:skillId": "removes a skill; nothing new runs"
};

/** Admin and skill submission routes that need no step-up, and why. */
const ADMIN_NO_STEP_UP: Record<string, string> = {
  // Changes that send tenant data nowhere new.
  "POST /admin/skills/:skillId/release-impact": "a preview: counts who gains or loses the skill; stores nothing",
  "POST /admin/skills/import/zip": "makes a draft that is off and has no active revision; nothing runs until a release",
  "POST /admin/skills/import/github": "makes a draft that is off and has no active revision; nothing runs until a release",
  "POST /admin/skills/import/inline": "makes a draft that is off and has no active revision; nothing runs until a release",
  "POST /admin/skills/:skillId/disable": "turns a skill off",
  "POST /admin/skills/:skillId/unpublish": "takes a skill away from members",
  "POST /admin/skills/revisions/cleanup": "deletes revisions that are not active",
  "POST /admin/users/:userId/set-beta-tester": "puts a member in or out of the test audience; the servers and skills of that audience were set with their own checks",
  "PUT /admin/model-spending": "a spending limit",
  "POST /admin/model-spending/:reservationId/close": "closes a spending reservation",
  "POST /admin/model-spending/:reservationId/reconcile": "reconciles a spending reservation",
  "POST /admin/artifacts/:artifactId/download-token": "a short download link for one file, for the admin who asks",
  "POST /admin/runtime-sessions/rollout": "ends or refreshes idle runtimes",
  "POST /admin/custom-models":
    "adds a vendor model id at a built-in provider; the provider's fixed address and the tenant's key stay the same",
  "DELETE /admin/custom-models": "removes a custom model",
  "POST /admin/policy/simulate": "evaluates a sample action; stores nothing",
  "DELETE /admin/integrations/:integrationId/config": "removes an integration's settings and turns it off",
  "POST /admin/mcp-servers/:serverId/connection-test": "calls the saved address with the saved settings; stores only the result",
  "POST /admin/mcp-servers/:serverId/widget-domains/revoke": "removes an approved widget domain",
  "POST /admin/mcp-servers/:serverId/disable": "turns a server off",
  "POST /admin/mcp-servers/:serverId/publish":
    "shows a server to all members; its address and secret were set with step-up (create or update)",
  "POST /admin/mcp-servers/:serverId/unpublish": "takes a server away from members",
  "POST /me/skill-submission-updates/:id/read": "marks the member's own update as read",
  "POST /me/skill-submissions": "the member submits a personal skill for review; nothing runs for others",
  "POST /me/skill-submissions/:id/withdraw": "the member withdraws a submission",
  "POST /me/skill-submissions/:id/resubmit": "the member submits a new revision for review",
  "POST /admin/skill-submissions/:id/decision": "an accepted submission becomes a pending draft; nothing runs until a release"
};

/**
 * Routes of these plugins that need no step-up, and why. Each one grants no
 * credential or account to the caller, changes nobody's sign-in rights,
 * sends no tenant data to a new place, makes no control weaker, and releases
 * no skill, or it is a public step that needs a secret other than an access
 * token.
 */
const NO_STEP_UP: Record<string, string> = {
  // Public sign-in steps: each needs a password, a link, a sign-in flow, or a
  // passkey answer. An access token adds nothing.
  "POST /auth/callback": "WorkOS sign-in result; needs the WorkOS code and the browser's state cookie",
  "POST /auth/refresh": "rotates the refresh cookie of its own family; grants nothing new",
  "POST /auth/logout": "ends this session",
  "POST /auth/local/login": "needs the password",
  "POST /auth/local/setup": "needs the one-time setup link",
  "POST /auth/local/password/reset": "needs the one-time reset link",
  "POST /auth/local/password/forgot": "emails a link to the account's own address; the caller gets nothing",
  "POST /auth/local/mfa/totp": "needs the sign-in flow and a code from the authenticator",
  "POST /auth/local/mfa/recovery": "needs the sign-in flow and a recovery code",
  "POST /auth/local/enroll/totp/start": "needs a sign-in enrolment flow (after the password)",
  "POST /auth/local/enroll/totp/confirm": "needs the sign-in enrolment flow and the secret it showed",
  "POST /auth/passkey/login/options": "public ceremony start; grants nothing",
  "POST /auth/passkey/login/verify": "needs a passkey of the account",
  "POST /auth/local/mfa/passkey/options": "needs the sign-in flow",
  "POST /auth/local/mfa/passkey/verify": "needs the sign-in flow and a passkey of the account",
  "POST /auth/local/enroll/passkey/options": "needs a sign-in enrolment flow",
  "POST /auth/local/enroll/passkey/verify": "needs the sign-in enrolment flow and its challenge",
  // Step-up itself: it checks a fresh proof and makes the token.
  "POST /auth/step-up": "checks the password or a code; makes the step-up token",
  "POST /auth/step-up/passkey/options": "starts a passkey step-up; grants nothing",
  "POST /auth/step-up/passkey": "checks a passkey; makes the step-up token",
  // Signed-in reads and changes that grant nothing.
  "PATCH /me/security/passkeys/:credentialId": "renames a passkey",
  "POST /me/security/sessions/revoke": "ends every session of the caller's own account",
  // The second half of a ceremony whose first half needs step-up.
  "POST /me/security/totp/confirm":
    "needs a code from the pending secret, which only the step-up start shows, and the session family that started it",
  "POST /me/security/passkeys/verify": "needs the challenge record of the step-up options, bound to this session",
  // Tenant settings and member reads.
  "PUT /tenant": "renames the tenant",
  "POST /tenant/members/:userId/sessions/revoke": "ends the member's sessions; grants nothing",
  "POST /tenant/members/:userId/link/resend":
    "emails a new link to the member's own address; the manager never sees it, and the address cannot change here",
  ...ADMIN_NO_STEP_UP,
  ...PROJECT_SKILL_NO_STEP_UP
};


/** Remaining core routes, reviewed against their handlers and stores. */
export const CORE_NO_STEP_UP: Record<string, string> = {
  ...NO_STEP_UP,
  "POST /admin/integrations/jira/cleanups/:cleanupId/retry": "withAdmin; retryCleanup deletes only remote accounts of the retired external identity in the tenant cleanup record",
  "DELETE /mcp/:serverId": "runtime-token gateway; closes transport, grants no credential",
  "POST /mcp/:serverId": "runtime-token and live tool-context admission, policy and approval checks apply per tool call; browser access token is insufficient",
  "DELETE /me/github-connection": "removes own connection and invalidates runtimes",
  "DELETE /me/jira-connection": "removes own connection and retries retired remote-account deletion",
  "DELETE /me/notion-connection": "removes own connection and invalidates runtimes",
  "DELETE /me/mcp-connections/:serverId/credentials": "removes own saved credential at the supplied version",
  "DELETE /me/memories/:memoryId": "deletes own memory",
  "DELETE /me/scheduled-jobs/:jobId": "deletes own job; no later execution is added",
  "DELETE /me/skills/:skillId": "deletes own skill at the supplied version",
  "DELETE /projects/:projectId/library/files/:fileId": "project editor soft-deletes a file; adds no data or access",
  "DELETE /projects/:projectId/library/folders/:folderId": "project editor removes a folder; adds no data or access",
  "DELETE /sessions/:sessionId": "moves own session to trash and stops its runtime",
  "PATCH /messages/:messageId/feedback": "saves feedback on an accessible message; not a credential or agent instruction",
  "POST /approvals/:approvalId/decision": "owner-bound approval coordinator checks pending interrupt and one-use decision; approves the current action, creates no reusable credential",
  "POST /artifacts": "session-owned upload admission and PII checks; saves content in that session",
  "POST /artifacts/:artifactId/download-token": "short-lived signed download of an owned artifact; bearer link remains valid until expiry by design",
  "POST /me/scheduled-jobs/preview": "parses schedule for preview; does not save a job",
  "POST /messages": "owns session and passes runtime admission, policy and tool checks; starts a current turn, not a reusable credential",
  "POST /projects/:projectId/sessions": "project editor creates a session in the accessible project; project access still applies on later use",
  "POST /sessions": "creates own session; later turns require live authentication",
  "POST /sessions/:sessionId/archive": "archives owned session and stops runtime",
  "POST /sessions/:sessionId/interrupt": "interrupts owned runtime; grants nothing",
  "POST /sessions/:sessionId/restore": "restores owned trash session; later turns require live authentication",
  "PUT /sessions/:sessionId/name": "renames owned session; does not alter execution settings",
  "PUT /projects/:projectId/archive": "project owner changes archive state under project access checks; later writes still require project access",
  "PUT /projects/:projectId": "project editor renames the project; does not change sharing or instructions",
  "PUT /projects/:projectId/sessions": "moves owned sessions after checking source and target project access; no new member grant"
};

// These are risks, not exemptions. Each reason states what persists and the follow-up.
export const SURVIVING_REVOCATION: Record<string, { reason: string; bead: string }> = {
  "POST /admin/projects/:projectId/recover-owner": { reason: "organization admin grants persistent owner role on an ownerless project to a current tenant member; no fresh proof", bead: "fff0" },
  "PUT /projects/:projectId/members/:userId": { reason: "project owner can grant persistent membership to another current tenant member; self-removal also uses this route", bead: "fff0" },
  "PUT /projects/:projectId/sharing": { reason: "project owner can share existing sessions and files with the organization after audience confirmation, without fresh proof", bead: "fff0" },
  "POST /me/github-connection/authorize": { reason: "starts external OAuth; callback saves a connection bound to local security version, but WorkOS has no revocation marker", bead: "q4w0.21" },
  "POST /me/github-connection/confirm": { reason: "reactivates own suspended connection using provider-attested login; WorkOS lacks account revocation", bead: "q4w0.21" },
  "PUT /me/github-connection/repositories": { reason: "persists own selected repositories; local owner version gates use, WorkOS lacks revocation marker", bead: "q4w0.21" },
  "POST /me/notion-connection/authorize": { reason: "starts OAuth; saved connection checks local owner version, WorkOS has no marker", bead: "q4w0.21" },
  "POST /me/notion-connection/confirm": { reason: "reactivates own connection with provider-attested email; WorkOS lacks account revocation", bead: "q4w0.21" },
  "POST /me/jira-connection/authorize": { reason: "issues Pipedream connect URL for own external identity; WorkOS has no account revocation marker", bead: "q4w0.21" },
  "PUT /me/jira-connection": { reason: "persists verified account/site selection and local owner version; WorkOS has no version", bead: "q4w0.21" },
  "PUT /me/mcp-connections/:serverId/credentials": { reason: "saves supplied secret under own scope and version; local version suspends later use, WorkOS lacks marker", bead: "q4w0.21" },
  "POST /me/scheduled-jobs": { reason: "saves future execution with local owner version; WorkOS jobs lack account revocation", bead: "q4w0.21" },
  "PUT /me/scheduled-jobs/:jobId": { reason: "edits own future execution and saver version; WorkOS jobs lack account revocation", bead: "q4w0.21" },
  "POST /projects": { reason: "creates persistent project and creator ownership with default execution settings", bead: "fff0" },
  "POST /me/skills": { reason: "creates own persistent skill draft, not shared with others", bead: "fff0" },
  "PUT /me/skills/:skillId": { reason: "saves own persistent skill draft at expected version", bead: "fff0" },
  "POST /me/skills/:skillId/action": { reason: "can release or enable personal skill for later turns; not an organization release", bead: "fff0" },
  "PUT /me/memories/:memoryId": { reason: "edits own persistent memory used by later turns", bead: "fff0" },
  "PUT /me/settings/:section": { reason: "saves own settings including agent instructions for later turns", bead: "fff0" },
  "PUT /me/capabilities": { reason: "saves own future default capability selection from available catalog", bead: "fff0" },
  "PUT /sessions/:sessionId/capabilities": { reason: "saves capability selection for later turns in owned session", bead: "fff0" },
  "PUT /projects/:projectId/capabilities": { reason: "project manager saves selection from accessible catalog for future project turns", bead: "fff0" },
  "PUT /projects/:projectId/instructions": { reason: "project owner changes persistent instructions for other project members", bead: "fff0" },
  "PUT /projects/:projectId/approval-mode": { reason: "project owner changes saved approval mode for later turns", bead: "fff0" },
  "PUT /projects/:projectId/agent-file-mode": { reason: "project owner changes saved file context mode for later turns", bead: "fff0" },
  "POST /projects/:projectId/library/files": { reason: "project editor copies an accessible artifact into persistent shared project context", bead: "fff0" },
  "POST /projects/:projectId/library/files/:fileId/promote": { reason: "project editor promotes content to persistent shared context", bead: "fff0" },
  "POST /projects/:projectId/library/files/:fileId/versions/:versionId/restore": { reason: "project editor restores old file content used by later turns", bead: "fff0" },
  "POST /projects/:projectId/library/folders": { reason: "project editor adds persistent library organization", bead: "fff0" },
  "PUT /projects/:projectId/library/files/:fileId/location": { reason: "project editor changes persistent shared file location", bead: "fff0" },
  "PUT /projects/:projectId/library/files/:fileId/restore": { reason: "project editor restores deleted shared context", bead: "fff0" },
  "PUT /projects/:projectId/library/files/:fileId/save-as-new": { reason: "project editor saves another persistent shared file", bead: "fff0" },
  "PUT /projects/:projectId/library/folders/:folderId": { reason: "project editor changes persistent library folder", bead: "fff0" }
};

// Optional distribution routes. The census checks these only when the real overlay attaches routes.
export const OVERLAY_CLASSIFICATIONS: Record<string, string> = {
  "PUT /tenant/settings/microsoft": "step-up integration.overlay_settings via DataRouteControl; WorkOS proof gap q4w0.20",
  "DELETE /tenant/settings/microsoft": "removes tenant app settings and disables integration",
  "DELETE /me/microsoft-connection": "removes own external connection",
  "POST /me/microsoft-connection/authorize": "OAuth connection saves local owner version; WorkOS revocation risk q4w0.21",
  "POST /me/microsoft-connection/confirm": "provider-attested email reactivates own suspended connection; WorkOS revocation risk q4w0.21",
  "POST /sessions/:sessionId/import-microsoft-file": "imports into owned session through upload and PII admission"
};
