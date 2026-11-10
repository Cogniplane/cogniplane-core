# HTTP routes

Scope: every HTTP route that the backend and the bundled overlays register,
grouped by source file. `scripts/generate-route-index.ts` generates the list; a
test fails when it is stale. `{name}` marks a path part that the code builds at
run time (read the file). Tags: `admin` when the handler is wrapped in
`withAdmin` (owners and admins); `step-up` when the route is a key of
`STEP_UP_ROUTES`. A route without a tag can still check a role in its handler.
Other auth rules are in the subsystem documents.

<!-- generated route index -->

## [routes/admin/admin-artifact-routes.ts](../apps/backend/src/routes/admin/admin-artifact-routes.ts)

- POST `/admin/artifacts/:artifactId/download-token` (admin)

## [routes/admin/admin-history-routes.ts](../apps/backend/src/routes/admin/admin-history-routes.ts)

- GET `/admin/history` (admin)
- GET `/admin/history/:eventId` (admin)

## [routes/admin/admin-integrations-routes.ts](../apps/backend/src/routes/admin/admin-integrations-routes.ts)

- GET `/admin/integrations` (admin)
- PUT `/admin/integrations/:integrationId` (admin, step-up)
- DELETE `/admin/integrations/:integrationId/config` (admin)

## [routes/admin/admin-mcp-server-routes.ts](../apps/backend/src/routes/admin/admin-mcp-server-routes.ts)

- GET `/admin/mcp-servers` (admin)
- POST `/admin/mcp-servers/:serverId/connection-test` (admin)
- GET `/admin/mcp-servers/:serverId/widget-domains` (admin)
- POST `/admin/mcp-servers/:serverId/widget-domains/approve` (admin, step-up)
- POST `/admin/mcp-servers/:serverId/widget-domains/revoke` (admin)
- POST `/admin/mcp-servers/setup` (admin, step-up)
- PUT `/admin/mcp-servers/:serverId/setup` (admin, step-up)
- PUT `/admin/mcp-servers/:serverId/inherited-availability` (admin, step-up)
- POST `/admin/mcp-servers` (admin, step-up)
- PUT `/admin/mcp-servers/:serverId` (admin, step-up)
- POST `/admin/mcp-servers/:serverId/disable` (admin)
- POST `/admin/mcp-servers/:serverId/publish` (admin, step-up)
- POST `/admin/mcp-servers/:serverId/unpublish` (admin)

## [routes/admin/admin-model-routes.ts](../apps/backend/src/routes/admin/admin-model-routes.ts)

- GET `/admin/models` (admin)
- GET `/admin/openrouter-models` (admin)
- POST `/admin/custom-models` (admin)
- DELETE `/admin/custom-models` (admin)

## [routes/admin/admin-model-spending-routes.ts](../apps/backend/src/routes/admin/admin-model-spending-routes.ts)

- GET `/admin/model-spending` (admin)
- PUT `/admin/model-spending` (admin)
- POST `/admin/model-spending/:reservationId/close` (admin)
- POST `/admin/model-spending/:reservationId/reconcile` (admin)

## [routes/admin/admin-person-access-routes.ts](../apps/backend/src/routes/admin/admin-person-access-routes.ts)

- GET `/admin/users/:userId/skills-connections` (admin)

## [routes/admin/admin-pii-routes.ts](../apps/backend/src/routes/admin/admin-pii-routes.ts)

- GET `/admin/pii/provider-status` (admin)
- GET `/admin/pii/metrics` (admin)
- GET `/admin/pii/top` (admin)
- GET `/admin/pii/jobs/stats` (admin)
- GET `/admin/pii/recent` (admin)

## [routes/admin/admin-policy-routes.ts](../apps/backend/src/routes/admin/admin-policy-routes.ts)

- GET `/admin/policy/rules` (admin)
- POST `/admin/policy/rules` (admin, step-up)
- PATCH `/admin/policy/rules/:ruleId` (admin, step-up)
- DELETE `/admin/policy/rules/:ruleId` (admin, step-up)
- POST `/admin/policy/simulate` (admin)
- GET `/admin/policy/decisions` (admin)
- GET `/admin/policy/monitor-summary` (admin)
- GET `/admin/policy/decisions/:decisionId` (admin)
- GET `/admin/policy/lint` (admin)
- PUT `/admin/policy/rules/order` (admin, step-up)

## [routes/admin/admin-runtime-routes.ts](../apps/backend/src/routes/admin/admin-runtime-routes.ts)

- GET `/admin/runtime-sessions` (admin)
- GET `/admin/diagnostics` (admin)
- GET `/admin/runtime-health` (admin)
- GET `/admin/runtime-config` (admin)
- POST `/admin/runtime-sessions/rollout` (admin)

## [routes/admin/admin-session-detail.ts](../apps/backend/src/routes/admin/admin-session-detail.ts)

- GET `/admin/sessions/:sessionId` (admin)

## [routes/admin/admin-session-routes.ts](../apps/backend/src/routes/admin/admin-session-routes.ts)

- GET `/admin/sessions` (admin)

## [routes/admin/admin-skill-routes.ts](../apps/backend/src/routes/admin/admin-skill-routes.ts)

- POST `/admin/skills/:skillId/release-impact` (admin)
- GET `/admin/skills` (admin)
- GET `/admin/skills/marketplace` (admin)
- POST `/admin/skills/:skillId/disable` (admin)
- POST `/admin/skills/import/zip` (admin)
- POST `/admin/skills/import/github` (admin)
- POST `/admin/skills/import/inline` (admin)
- GET `/admin/skills/:skillId/revisions` (admin)
- GET `/admin/skills/:skillId/revisions/:skillRevisionId/files` (admin)
- POST `/admin/skills/:skillId/revisions/:skillRevisionId/activate` (admin, step-up)
- POST `/admin/skills/:skillId/publish` (admin, step-up)
- POST `/admin/skills/:skillId/unpublish` (admin)
- POST `/admin/skills/revisions/cleanup` (admin)

## [routes/admin/admin-tenant-settings-routes.ts](../apps/backend/src/routes/admin/admin-tenant-settings-routes.ts)

- GET `/admin/tenant-settings` (admin)
- GET `/admin/managed-tools` (admin)
- PUT `/admin/tenant-settings` (admin, step-up)

## [routes/admin/admin-token-usage-routes.ts](../apps/backend/src/routes/admin/admin-token-usage-routes.ts)

- GET `/admin/token-usage` (admin)

## [routes/admin/admin-user-routes.ts](../apps/backend/src/routes/admin/admin-user-routes.ts)

- GET `/admin/users` (admin)
- POST `/admin/users/:userId/set-beta-tester` (admin)

## [routes/approvals.ts](../apps/backend/src/routes/approvals.ts)

- GET `/sessions/:sessionId/approvals`
- POST `/approvals/:approvalId/decision`

## [routes/artifacts.ts](../apps/backend/src/routes/artifacts.ts)

- GET `/artifacts`
- GET `/sessions/:sessionId/artifacts`
- POST `/artifacts`
- POST `/artifacts/:artifactId/download-token`
- GET `/artifacts/:artifactId/preview-text`
- GET `/downloads/:token`

## [routes/auth-local.ts](../apps/backend/src/routes/auth-local.ts)

- POST `/auth/local/login`
- POST `/auth/local/setup`
- POST `/auth/local/password/reset`
- POST `/auth/local/password/forgot`
- POST `/auth/local/mfa/totp`
- POST `/auth/local/mfa/recovery`
- POST `/auth/local/enroll/totp/start`
- POST `/auth/local/enroll/totp/confirm`
- POST `/auth/step-up`
- GET `/me/security`
- POST `/me/security/password` (step-up)
- POST `/me/security/totp/start` (step-up)
- POST `/me/security/totp/confirm`
- DELETE `/me/security/totp` (step-up)
- POST `/me/security/recovery-codes` (step-up)
- POST `/me/security/sessions/revoke`
- POST `/auth/passkey/login/options`
- POST `/auth/passkey/login/verify`
- POST `/auth/local/mfa/passkey/options`
- POST `/auth/local/mfa/passkey/verify`
- POST `/auth/local/enroll/passkey/options`
- POST `/auth/local/enroll/passkey/verify`
- POST `/auth/step-up/passkey/options`
- POST `/auth/step-up/passkey`
- GET `/me/security/passkeys`
- POST `/me/security/passkeys/options` (step-up)
- POST `/me/security/passkeys/verify`
- PATCH `/me/security/passkeys/:credentialId`
- DELETE `/me/security/passkeys/:credentialId` (step-up)

## [routes/auth-session.ts](../apps/backend/src/routes/auth-session.ts)

- POST `/auth/refresh`
- POST `/auth/logout`
- GET `/auth/me`

## [routes/auth.ts](../apps/backend/src/routes/auth.ts)

- GET `/auth/config`
- GET `/auth/login`
- POST `/auth/callback`
- GET `/auth/organizations`

## [routes/health.ts](../apps/backend/src/routes/health.ts)

- GET `/health`
- GET `/ready`

## [routes/mcp.ts](../apps/backend/src/routes/mcp.ts)

- GET `/mcp/:serverId`
- DELETE `/mcp/:serverId`
- POST `/mcp/:serverId`

## [routes/member-mcp.ts](../apps/backend/src/routes/member-mcp.ts)

- GET `/me/mcp-connections`
- PUT `/me/mcp-connections/:serverId/credentials`
- DELETE `/me/mcp-connections/:serverId/credentials`

## [routes/memories.ts](../apps/backend/src/routes/memories.ts)

- GET `/me/memories`
- PUT `/me/memories/:memoryId`
- DELETE `/me/memories/:memoryId`

## [routes/message-feedback-routes.ts](../apps/backend/src/routes/message-feedback-routes.ts)

- PATCH `/messages/:messageId/feedback`
- GET `/admin/message-feedback` (admin)

## [routes/messages.ts](../apps/backend/src/routes/messages.ts)

- POST `/messages`

## [routes/models.ts](../apps/backend/src/routes/models.ts)

- GET `/models`

## [routes/organization-skill-submissions.ts](../apps/backend/src/routes/organization-skill-submissions.ts)

- GET `/me/skill-submissions`
- GET `/me/skill-submission-updates`
- POST `/me/skill-submission-updates/:id/read`
- POST `/me/skill-submissions`
- GET `/me/skill-submissions/:id`
- POST `/me/skill-submissions/:id/withdraw`
- POST `/me/skill-submissions/:id/resubmit`
- GET `/admin/skill-submissions`
- GET `/admin/skill-submissions/:id`
- POST `/admin/skill-submissions/:id/decision`
- POST `/admin/skill-submissions/:id/release` (step-up)

## [routes/personal-capabilities.ts](../apps/backend/src/routes/personal-capabilities.ts)

- GET `/me/capabilities`
- PUT `/me/capabilities`

## [routes/personal-skills.ts](../apps/backend/src/routes/personal-skills.ts)

- GET `/me/skills`
- POST `/me/skills`
- GET `/me/skills/:skillId`
- PUT `/me/skills/:skillId`
- POST `/me/skills/:skillId/action`
- DELETE `/me/skills/:skillId`
- GET `/me/skills/:skillId/history`

## [routes/project-capabilities.ts](../apps/backend/src/routes/project-capabilities.ts)

- GET `/projects/:projectId/capabilities`
- PUT `/projects/:projectId/capabilities`

## [routes/project-files.ts](../apps/backend/src/routes/project-files.ts)

- GET `/projects/:projectId/library`
- GET `/projects/:projectId/library/files`
- GET `/projects/:projectId/library/picker`
- GET `/projects/:projectId/library/picker/selection`
- GET `/projects/:projectId/library/folders`
- GET `/projects/:projectId/library/folders/:folderId`
- POST `/projects/:projectId/library/files`
- POST `/projects/:projectId/library/folders`
- PUT `/projects/:projectId/library/folders/:folderId`
- DELETE `/projects/:projectId/library/folders/:folderId`
- PUT `/projects/:projectId/library/files/:fileId/location`
- PUT `/projects/:projectId/library/files/:fileId/restore`
- PUT `/projects/:projectId/library/files/:fileId/save-as-new`
- POST `/projects/:projectId/library/files/:fileId/promote`
- DELETE `/projects/:projectId/library/files/:fileId`
- GET `/projects/:projectId/library/files/:fileId/versions`
- POST `/projects/:projectId/library/files/:fileId/versions/:versionId/restore`
- GET `/projects/:projectId/library/files/:fileId/versions/:versionId/content`
- GET `/projects/:projectId/library/files/:fileId/versions/:versionId/preview-text`

## [routes/project-members.ts](../apps/backend/src/routes/project-members.ts)

- GET `/projects/:projectId/members`
- PUT `/projects/:projectId/sharing`
- PUT `/projects/:projectId/members/:userId`
- GET `/admin/projects/ownerless`
- POST `/admin/projects/:projectId/recover-owner`

## [routes/project-skills.ts](../apps/backend/src/routes/project-skills.ts)

- GET `/projects/:projectId/skills`
- POST `/projects/:projectId/skills`
- POST `/projects/:projectId/skills/from-personal`
- GET `/projects/:projectId/skills/:skillId`
- GET `/projects/:projectId/skills/:skillId/history`
- PUT `/projects/:projectId/skills/:skillId`
- POST `/projects/:projectId/skills/:skillId/from-personal`
- POST `/projects/:projectId/skills/:skillId/action` (step-up)
- DELETE `/projects/:projectId/skills/:skillId`

## [routes/projects.ts](../apps/backend/src/routes/projects.ts)

- GET `/projects`
- GET `/projects/:projectId/instructions/status`
- PUT `/projects/:projectId/instructions`
- PUT `/projects/:projectId/approval-mode`
- PUT `/projects/:projectId/agent-file-mode`
- PUT `/projects/:projectId/archive`
- POST `/projects`
- GET `/projects/:projectId/sessions`
- GET `/projects/:projectId/artifacts`
- GET `/projects/:projectId`
- PUT `/projects/:projectId`
- POST `/projects/:projectId/sessions`
- PUT `/projects/:projectId/sessions`

## [routes/session-capabilities.ts](../apps/backend/src/routes/session-capabilities.ts)

- GET `/sessions/:sessionId/capabilities`
- PUT `/sessions/:sessionId/capabilities`

## [routes/sessions.ts](../apps/backend/src/routes/sessions.ts)

- GET `/sessions/:sessionId/mcp-apps/:toolCallId`
- GET `/sessions/:sessionId/connect`
- GET `/sessions`
- POST `/sessions`
- PUT `/sessions/:sessionId/name`
- POST `/sessions/:sessionId/archive`
- POST `/sessions/:sessionId/restore`
- POST `/sessions/:sessionId/interrupt`
- DELETE `/sessions/:sessionId`
- GET `/sessions/:sessionId/messages`

## [routes/settings.ts](../apps/backend/src/routes/settings.ts)

- GET `/me/settings`
- PUT `/me/settings/:section`
- GET `/me/integrations-availability`
- GET `/me/scheduled-jobs`
- POST `/me/scheduled-jobs/preview`
- POST `/me/scheduled-jobs`
- PUT `/me/scheduled-jobs/:jobId`
- GET `/me/scheduled-jobs/:jobId/runs`
- DELETE `/me/scheduled-jobs/:jobId`
- GET `/me/token-usage`

## [routes/tenant-local-members.ts](../apps/backend/src/routes/tenant-local-members.ts)

- POST `/tenant/members` (step-up)
- POST `/tenant/members/:userId/password-reset` (step-up)
- POST `/tenant/members/:userId/link/resend`
- POST `/tenant/members/:userId/disable` (step-up)
- POST `/tenant/members/:userId/enable` (step-up)
- POST `/tenant/members/:userId/mfa-reset` (step-up)
- GET `/tenant/settings/security`
- PUT `/tenant/settings/security` (step-up)
- POST `/tenant/members/:userId/sessions/revoke`

## [routes/tenant.ts](../apps/backend/src/routes/tenant.ts)

- GET `/tenant`
- PUT `/tenant`
- PUT `/tenant/settings` (step-up)
- PUT `/tenant/settings/marketplace` (step-up)
- PUT `/tenant/settings/pii` (step-up)
- GET `/tenant/members`
- PUT `/tenant/members/:userId/role` (step-up)
- DELETE `/tenant/members/:userId` (step-up)

## [services/integrations/github/github-oauth-routes.ts](../apps/backend/src/services/integrations/github/github-oauth-routes.ts)

- GET `/auth/github/user/callback`

## [services/integrations/github/github-settings-routes.ts](../apps/backend/src/services/integrations/github/github-settings-routes.ts)

- GET `/me/github-connection`
- POST `/me/github-connection/authorize`
- GET `/me/github-connection/repositories`
- PUT `/me/github-connection/repositories`
- POST `/me/github-connection/confirm`
- DELETE `/me/github-connection`

## [services/integrations/notion/notion-oauth-routes.ts](../apps/backend/src/services/integrations/notion/notion-oauth-routes.ts)

- GET `/integrations/notion/callback`

## [services/integrations/notion/notion-settings-routes.ts](../apps/backend/src/services/integrations/notion/notion-settings-routes.ts)

- GET `/me/notion-connection`
- POST `/me/notion-connection/authorize`
- POST `/me/notion-connection/confirm`
- DELETE `/me/notion-connection`

## [services/integrations/pipedream/jira-connection-routes.ts](../apps/backend/src/services/integrations/pipedream/jira-connection-routes.ts)

- GET `/me/jira-connection`
- POST `/me/jira-connection/authorize`
- GET `/me/jira-connection/accounts`
- GET `/me/jira-connection/accounts/:accountId/sites`
- PUT `/me/jira-connection`
- DELETE `/me/jira-connection`
- GET `/admin/integrations/jira/cleanups` (admin)
- POST `/admin/integrations/jira/cleanups/:cleanupId/retry` (admin)

## [private/sharepoint-overlay-backend/src/routes/microsoft-files.ts](../private/sharepoint-overlay-backend/src/routes/microsoft-files.ts)

- GET `/integrations/microsoft/sites`
- GET `/integrations/microsoft/files`
- GET `/integrations/microsoft/files/search`
- POST `/sessions/:sessionId/import-microsoft-file`

## [private/sharepoint-overlay-backend/src/routes/microsoft-settings-routes.ts](../private/sharepoint-overlay-backend/src/routes/microsoft-settings-routes.ts)

- GET `/me/microsoft-connection`
- POST `/me/microsoft-connection/authorize`
- POST `/me/microsoft-connection/confirm`
- DELETE `/me/microsoft-connection`

## [private/sharepoint-overlay-backend/src/routes/microsoft-tenant-routes.ts](../private/sharepoint-overlay-backend/src/routes/microsoft-tenant-routes.ts)

- PUT `/tenant/settings/microsoft`
- DELETE `/tenant/settings/microsoft`

## [private/sharepoint-overlay-backend/src/services/microsoft-oauth-routes.ts](../private/sharepoint-overlay-backend/src/services/microsoft-oauth-routes.ts)

- GET `/integrations/microsoft/callback`
