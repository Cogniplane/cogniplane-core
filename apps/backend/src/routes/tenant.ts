import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  buildPiiProtectionSettingsRequestSchema,
  TenantDetailsSchema,
  TenantProviderKeyUpdateRequestSchema
} from "@cogniplane/shared-types";

import type { Pool } from "../lib/db.js";
import { withTenantScope } from "../lib/db.js";
import { apiError } from "../lib/http-errors.js";
import { requireRole } from "../lib/rbac.js";
import { parseRequestInput } from "../lib/route-validation.js";
import { serialize } from "../lib/serialize-response.js";
import { httpsUrlSchema } from "../lib/url-validation.js";
import { AuditEventStore, type AuditEventInput } from "../services/audit-event-store.js";
import type { AuditEventType } from "../services/audit-event-types.js";
import {
  cancelOpenLinks,
  lockLocalIdentityForMembershipChange,
  markLocalIdentityRemoved
} from "../services/auth/local-account-service.js";
import { type LocalAuth, requireStepUp } from "../services/auth/local-auth.js";
import { type AfterSecurityChange, withSecurityChange } from "../services/auth/security-change.js";
import type { StepUpRoute } from "../services/auth/step-up-routes.js";
import { LocalMfaService } from "../services/auth/local-mfa-service.js";
import type { DataRouteControl } from "../services/data-route-control.js";
import { currentRole, isManager, lockTenantMembership, mayAssignRole, ownerRoleRefusal } from "../services/member-authority.js";
import type { GithubConnectionService } from "../services/integrations/github/github-connection-service.js";
import { IntegrationRegistry } from "../services/integrations/integration-registry.js";
import { PiiImportScopeRegistry } from "../services/pii/pii-import-scopes.js";
import { resolvePiiPolicy } from "../services/pii/pii-policy.js";
import { weakerPiiFields } from "../services/pii/pii-weakening.js";
import { PiiSettingsConflictError, type TenantOrgSettingsStore } from "../services/tenant-org-settings-store.js";
import { registerLocalMemberRoutes } from "./tenant-local-members.js";

const tenantUpdateSchema = z.object({
  tenantName: z.string().trim().min(1).max(200).optional()
});

/** Text that a mail program can show as a link or an address. */
export function looksLikeLinkOrAddress(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes("://") || lower.includes("www.") || lower.includes("@");
}

const marketplaceSchema = z.object({
  skillMarketplaceManifestUrl: z.string().nullable().optional()
});

const memberRoleSchema = z.object({
  role: z.string()
});
const memberParamsSchema = z.object({
  userId: z.string().trim().min(1).max(80).regex(/^[a-z0-9][a-z0-9-_]*$/)
});

// Tenant-level audit event for an admin action on this request.
function tenantAudit(
  request: FastifyRequest,
  type: AuditEventType,
  payload: Record<string, unknown>
): AuditEventInput {
  return {
    tenantId: request.auth.tenantId,
    sessionId: null,
    userId: request.auth.userId,
    type,
    payload,
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"] ?? null
  };
}

export async function registerTenantRoutes(
  app: FastifyInstance,
  {
    db,
    tenantOrgSettings,
    githubConnections,
    afterSecurityChange,
    integrationDescriptors = new IntegrationRegistry(),
    piiImportScopes = new PiiImportScopeRegistry(),
    localAuth,
    dataRoutes
  }: {
    db: Pool;
    tenantOrgSettings: TenantOrgSettingsStore;
    githubConnections?: GithubConnectionService;
    /**
     * After the commit of a role change that increments a security version,
     * or of a member removal: stops the member's active work
     * (services/auth/security-change.ts).
     */
    afterSecurityChange: AfterSecurityChange;
    integrationDescriptors?: IntegrationRegistry;
    /** Import sources that overlays registered. They decide the configurable PII scopes. */
    piiImportScopes?: Pick<PiiImportScopeRegistry, "list" | "requestScopeKeys">;
    /** Set when local login is enabled: manager actions on local accounts. */
    localAuth?: LocalAuth;
    /**
     * Step-up and owner notice of the provider key (a data route), the skill
     * marketplace address, and a PII save that makes the protection weaker;
     * the owner notice of a rename.
     */
    dataRoutes: Pick<DataRouteControl, "requireStepUp" | "ownerNotice" | "writeWithStepUpIfWeaker">;
  }
): Promise<void> {
  if (localAuth) {
    await registerLocalMemberRoutes(app, { localAuth });
  }

  /**
   * Step-up for a manager change of a member's role or membership. The
   * target's login path decides, not the caller's session, so no caller
   * skips it: a local member needs the manager's step-up for the route (a
   * WorkOS session cannot give one), and a WorkOS member needs none, because
   * WorkOS owns that member's sign-in. An unknown member needs none either:
   * the change then answers 404. Writes the refusal and returns false when
   * the request must stop.
   */
  async function requireStepUpForLocalTarget(
    request: FastifyRequest,
    reply: FastifyReply,
    targetUserId: string,
    route: StepUpRoute
  ): Promise<boolean> {
    const { tenantId } = request.auth;
    const targetSource = await withTenantScope(db, tenantId, async (client) => {
      const row = await client.query<{ user_auth_source: string }>(
        `SELECT user_auth_source FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2`,
        [tenantId, targetUserId]
      );
      return row.rows[0]?.user_auth_source ?? null;
    });
    if (targetSource !== "local") return true;
    if (!localAuth) {
      reply.code(403).send({ error: "step_up_required" });
      return false;
    }
    return (await requireStepUp(request, reply, localAuth, route)) !== null;
  }

  app.get("/tenant", async (request, reply) => {
    const { tenantId } = request.auth;

    const result = await withTenantScope(db, tenantId, (client) =>
      client.query(
        `SELECT tenant_id, tenant_name, slug, sso_provider, plan, created_at, updated_at
         FROM tenants WHERE tenant_id = $1 LIMIT 1`,
        [tenantId]
      )
    );

    if (!result.rows[0]) {
      return reply.code(404).send({ error: "tenant_not_found" });
    }

    const row = result.rows[0];
    const orgSettings = await tenantOrgSettings.get(tenantId);
    const githubStatus = githubConnections
      ? await githubConnections.getConnectionStatus(tenantId, request.auth.userId)
      : { configured: false };
    const pii = resolvePiiPolicy(orgSettings.storedPiiProtection, piiImportScopes);
    // The roles that can save the PII policy get its health: the same reason
    // codes and field paths as the admin PII metrics, never stored values.
    const canSavePii = request.auth.role === "owner" || request.auth.role === "admin";

    return reply.send(serialize(TenantDetailsSchema, {
      tenantId: row.tenant_id,
      tenantName: row.tenant_name,
      slug: row.slug,
      ssoProvider: row.sso_provider,
      plan: row.plan,
      settings: {
        providerKeys: orgSettings.providerKeys,
        skillMarketplaceManifestUrl: orgSettings.skillMarketplaceManifestUrl,
        piiProtection: pii.settings,
        piiProtectionRevision: orgSettings.piiProtectionRevision,
        ...(canSavePii ? { piiProtectionHealth: pii.health } : {}),
        github: {
          configured: githubStatus.configured
        }
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  });

  // Rename the tenant (owner only). The name appears in every owner notice
  // (in a labelled field), so it must not look like a link or an address,
  // and a rename writes an audit event and notifies the owners, in its
  // transaction. Coalescing keeps the notices few (mail-outbox.ts).
  app.put("/tenant", async (request, reply) => {
    if (!requireRole(request, reply, "owner")) return;

    const { tenantId } = request.auth;
    const parsed = parseRequestInput(reply, tenantUpdateSchema, request.body);
    if (!parsed.ok) return parsed.response;
    const { tenantName } = parsed.value;

    if (!tenantName) {
      return reply.code(400).send({ error: "no_updates" });
    }
    if (looksLikeLinkOrAddress(tenantName)) {
      return reply.code(400).send(apiError("invalid_tenant_name",
        "Use a plain organization name. A name cannot contain a link or an email address (\"://\", \"www.\", or \"@\")."));
    }

    const result = await withTenantScope(db, tenantId, async (client) => {
      const before = await client.query<{ tenant_name: string }>(
        `SELECT tenant_name FROM tenants WHERE tenant_id = $1 FOR UPDATE`,
        [tenantId]
      );
      const updated = await client.query(
        `UPDATE tenants SET tenant_name = $1, updated_at = NOW() WHERE tenant_id = $2
         RETURNING tenant_id, tenant_name, slug, plan, updated_at`,
        [tenantName, tenantId]
      );
      const previousName = before.rows[0]?.tenant_name;
      if (updated.rows[0] && previousName !== undefined && previousName !== tenantName) {
        await AuditEventStore.createInTransaction(client, {
          ...tenantAudit(request, "tenant.renamed", { previousName, tenantName }),
          alsoInTransaction: dataRoutes.ownerNotice(request, { setting: "organization_name", previousName })
        });
      }
      return updated;
    });

    return reply.send(result.rows[0]);
  });

  // A provider API key (owner only). The key decides which provider account
  // gets every prompt of the tenant: a data route.
  app.put("/tenant/settings", async (request, reply) => {
    if (!requireRole(request, reply, "owner")) return;

    const { tenantId } = request.auth;
    const parsed = parseRequestInput(reply, TenantProviderKeyUpdateRequestSchema, request.body);
    if (!parsed.ok) return parsed.response;
    const { provider, apiKey } = parsed.value;
    if (!(await dataRoutes.requireStepUp(request, reply, "PUT /tenant/settings"))) return reply;
    // An explicitly empty key revokes only the selected provider's credential.
    const trimmedKey = apiKey.trim() || null;
    // The audit event and the owner notice commit with the change. Neither
    // carries the key.
    await tenantOrgSettings.setApiKey(tenantId, provider, trimmedKey, {
      ...tenantAudit(request, "tenant.provider_key.updated", { provider, keySet: trimmedKey !== null }),
      alsoInTransaction: dataRoutes.ownerNotice(request, { setting: "provider_key", provider, removed: trimmedKey === null })
    });
    const refreshed = await tenantOrgSettings.get(tenantId);

    return reply.send({
      ok: true,
      providerKeys: refreshed.providerKeys
    });
  });

  // Update org skill marketplace manifest URL (owner/admin only)
  app.put("/tenant/settings/marketplace", async (request, reply) => {
    if (!requireRole(request, reply, "owner", "admin")) return;

    const { tenantId } = request.auth;
    const parsed = parseRequestInput(reply, marketplaceSchema, request.body);
    if (!parsed.ok) return parsed.response;
    const url = parsed.value.skillMarketplaceManifestUrl;

    // Validate if a non-null value provided. The shared httpsUrlSchema enforces
    // https-only AND blocks private/reserved IPs (loopback, RFC1918, link-local
    // 169.254/16 incl. AWS IMDS, etc.) so a tenant owner cannot point the
    // marketplace fetcher at internal infrastructure for SSRF.
    if (url !== null && url !== undefined && url.trim() !== "") {
      if (url.length > 2048) {
        return reply.code(400).send({ error: "url_too_long" });
      }
      if (!httpsUrlSchema.safeParse(url).success) {
        return reply.code(400).send({ error: "invalid_url" });
      }
    }

    const value = (url === null || url === undefined || url.trim() === "") ? null : url.trim();

    // An address decides where admins import skills from: step-up and the
    // owner notice. Removing it imports from nowhere, so it needs neither.
    if (value !== null && !(await dataRoutes.requireStepUp(request, reply, "PUT /tenant/settings/marketplace"))) return reply;
    await tenantOrgSettings.setMarketplaceUrl(tenantId, value, {
      ...tenantAudit(request, "tenant.marketplace_url.updated", { skillMarketplaceManifestUrl: value }),
      alsoInTransaction: value === null ? undefined : dataRoutes.ownerNotice(request, { setting: "skill_marketplace" })
    });

    return reply.send({ ok: true, skillMarketplaceManifestUrl: value });
  });

  // Update org PII protection settings (owner/admin only)
  app.put("/tenant/settings/pii", async (request, reply) => {
    if (!requireRole(request, reply, "owner", "admin")) return;

    // Core scopes, registered import scopes, and the legacy keys (see
    // LEGACY_PII_SCOPE_KEYS). Any other scope key is a validation error.
    const parsed = buildPiiProtectionSettingsRequestSchema(piiImportScopes.requestScopeKeys()).safeParse(request.body);
    if (!parsed.success) {
      const details = parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message
      }));
      return reply.code(400).send({
        error: "validation_error",
        message: details.map((d) => (d.path ? `${d.path}: ${d.message}` : d.message)).join("; "),
        details
      });
    }

    if (parsed.data.enabled && parsed.data.mode === "off") {
      return reply.code(400).send({
        error: "invalid_combination",
        message: "enabled=true requires mode != off",
        details: [{ path: "mode", message: "enabled=true requires mode != off" }]
      });
    }

    const { tenantId } = request.auth;
    // The revision is not part of the stored policy. A save that names a
    // revision is refused when another save changed the settings first.
    // Compatibility path: a save with no revision (an older frontend) replaces
    // the settings with no check. Remove it when all clients send a revision.
    const { expectedRevision, ...policy } = parsed.data;
    let saved;
    try {
      // A save that makes the protection weaker needs step-up and sends the
      // owner notice (pii-weakening.ts). The store classifies it against the
      // locked row, after the revision check, so a stale save answers 409
      // before it spends a step-up token, and the resend after step-up sends
      // the same revision.
      const written = await dataRoutes.writeWithStepUpIfWeaker(request, reply, "PUT /tenant/settings/pii",
        (allowWeaker) => tenantOrgSettings.setPiiProtection(tenantId, policy, {
          expectedRevision,
          weakerFields: (stored, next) => weakerPiiFields(stored, next, piiImportScopes),
          allowWeaker,
          // `checked` is false on the compatibility path, which saves with no revision check.
          audit: (stored, revision, weakerFields) => ({
            ...tenantAudit(request, "tenant.pii_protection.updated", {
              piiProtection: stored,
              revision,
              checked: expectedRevision !== undefined,
              weakerFields
            }),
            alsoInTransaction: weakerFields.length > 0
              ? dataRoutes.ownerNotice(request, { setting: "pii_protection", fields: weakerFields })
              : undefined
          })
        }));
      if (!written) return reply;
      saved = written.saved;
    } catch (error) {
      if (error instanceof PiiSettingsConflictError) {
        return reply.code(409).send(apiError("pii_settings_conflict",
          "The PII settings changed after you loaded them. Reload the settings and try again."));
      }
      throw error;
    }

    return reply.send({
      ok: true,
      piiProtection: resolvePiiPolicy(saved.stored, piiImportScopes).settings,
      piiProtectionRevision: saved.revision
    });
  });

  // List tenant members (owner/admin only)
  app.get("/tenant/members", async (request, reply) => {
    if (!requireRole(request, reply, "owner", "admin")) return;

    const { tenantId } = request.auth;

    const result = await withTenantScope(db, tenantId, (client) =>
      client.query(
        `SELECT u.user_id, u.email, u.display_name, tm.role, tm.created_at,
                li.status AS account_status, li.last_login_at
         FROM tenant_memberships tm
         JOIN users u ON u.user_id = tm.user_id
         LEFT JOIN local_identities li ON li.tenant_id = tm.tenant_id AND li.user_id = tm.user_id
         WHERE tm.tenant_id = $1
         ORDER BY tm.created_at ASC`,
        [tenantId]
      )
    );

    return reply.send(
      result.rows.map((row) => ({
        userId: row.user_id,
        email: row.email,
        displayName: row.display_name,
        role: row.role,
        joinedAt: row.created_at,
        // Local accounts only; null for WorkOS members.
        accountStatus: row.account_status ?? null,
        lastLoginAt: row.last_login_at ?? null
      }))
    );
  });

  // Update member role (owner/admin only, cannot demote owner)
  app.put("/tenant/members/:userId/role", async (request, reply) => {
    if (!requireRole(request, reply, "owner", "admin")) return;

    const { tenantId } = request.auth;
    const params = parseRequestInput(reply, memberParamsSchema, request.params);
    if (!params.ok) return params.response;
    const targetUserId = params.value.userId;
    const parsed = parseRequestInput(reply, memberRoleSchema, request.body);
    if (!parsed.ok) return parsed.response;
    const { role } = parsed.value;

    if (!["owner", "admin", "member"].includes(role)) {
      return reply.code(400).send({ error: "invalid_role" });
    }

    // Only owners grant elevated roles. An admin who could mint more admins
    // could entrench accomplices the owner has no single action to undo.
    if ((role === "owner" || role === "admin") && request.auth.role !== "owner") {
      return reply
        .code(403)
        .send({ error: role === "owner" ? "only_owner_can_assign_owner" : "only_owner_can_assign_admin" });
    }

    // Cannot change your own role
    if (targetUserId === request.auth.userId) {
      return reply.code(400).send({ error: "cannot_change_own_role" });
    }

    // A role decides what the account can do: an access token alone must not
    // make an account an admin or an owner, for example one that the token's
    // holder created. Same rule as removal.
    if (!(await requireStepUpForLocalTarget(request, reply, targetUserId, "PUT /tenant/members/:userId/role"))) return reply;

    const outcome = await withSecurityChange(db, tenantId, afterSecurityChange, async (client, change) => {
      // The tenant's membership lock first, as every manager change takes it
      // (services/member-authority.ts): a role change and any other manager
      // change in this tenant run one at a time. Then the local identity, then
      // the member's chats (a promotion can be a security change, which takes
      // their sandboxes), then the membership.
      await lockTenantMembership(client, tenantId);
      const localStatus = await lockLocalIdentityForMembershipChange(client, tenantId, targetUserId);
      await change.lockChatsBeforeMembership(targetUserId);
      const target = await client.query(
        `SELECT role FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE`,
        [tenantId, targetUserId]
      );

      if (!target.rows[0]) {
        return { kind: "missing" as const };
      }

      // The caller's role as committed now, not as the request started
      // (services/member-authority.ts).
      const actorRole = await currentRole(client, tenantId, { userId: request.auth.userId, securityVersion: request.auth.session?.securityVersion });
      const assignRefusal = mayAssignRole(actorRole, role as "owner" | "admin" | "member");
      if (assignRefusal) {
        return { kind: "refused" as const, error: assignRefusal === "not_a_manager" ? "forbidden" : assignRefusal };
      }

      if (target.rows[0].role === "owner" && role !== "owner") {
        return { kind: "cannot_demote_owner" as const };
      }

      // Mirror of the elevation guard: an admin who could demote peers could
      // strip every other admin and entrench themselves as the only one.
      if (target.rows[0].role === "admin" && actorRole !== "owner") {
        return { kind: "only_owner_can_change_admin_role" as const };
      }

      // A local account that is not active must finish setup (or be enabled)
      // before it becomes an owner; otherwise only operator recovery could
      // unlock it. Member creation applies the same rule (ownerRoleRefusal).
      if (target.rows[0].role !== "owner" && ownerRoleRefusal(role as "owner" | "admin" | "member", localStatus)) {
        return { kind: "account_not_active" as const };
      }

      const result = await client.query(
        `UPDATE tenant_memberships SET role = $1, updated_at = NOW()
          WHERE tenant_id = $2 AND user_id = $3
          RETURNING tenant_id, user_id, role`,
        [role, tenantId, targetUserId]
      );
      // A link issued while the member had the old role must not outlive it:
      // an admin who got a member's reset link must not keep it after the
      // member becomes an owner or admin.
      if (localStatus !== null && target.rows[0].role !== role) {
        await cancelOpenLinks(client, tenantId, targetUserId);
        // A promotion into the group the MFA policy covers ends the member's
        // sessions when the member has no second factor yet.
        await LocalMfaService.applyPolicyToRoleChange(change, targetUserId, target.rows[0].role, role as "owner" | "admin" | "member");
      }
      await AuditEventStore.createInTransaction(client, tenantAudit(request, "tenant.member.role_changed", {
        targetUserId,
        previousRole: target.rows[0].role,
        role
      }));

      return { kind: "updated" as const, row: result.rows[0] };
    });

    if (outcome.kind === "missing") {
      return reply.code(404).send({ error: "member_not_found" });
    }

    if (outcome.kind === "cannot_demote_owner") {
      return reply.code(403).send({ error: "cannot_demote_owner" });
    }

    if (outcome.kind === "only_owner_can_change_admin_role") {
      return reply.code(403).send({ error: "only_owner_can_change_admin_role" });
    }

    if (outcome.kind === "refused") {
      return reply.code(403).send({ error: outcome.error });
    }

    if (outcome.kind === "account_not_active") {
      return reply.code(409).send({ error: "account_not_active" });
    }

    return reply.send(outcome.row);
  });

  // Remove member (owner/admin only)
  app.delete("/tenant/members/:userId", async (request, reply) => {
    if (!requireRole(request, reply, "owner", "admin")) return;

    const { tenantId } = request.auth;
    const params = parseRequestInput(reply, memberParamsSchema, request.params);
    if (!params.ok) return params.response;
    const targetUserId = params.value.userId;

    // Cannot remove yourself
    if (targetUserId === request.auth.userId) {
      return reply.code(400).send({ error: "cannot_remove_self" });
    }

    // Removing a local account ends it for good, so it needs the manager's
    // fresh proof, like reset and disable.
    if (!(await requireStepUpForLocalTarget(request, reply, targetUserId, "DELETE /tenant/members/:userId"))) return reply;

    // After the commit, the member's live interactive and scheduled turns stop,
    // and the sandboxes of the member's chats are killed
    // (services/auth/security-change.ts). Runtime admission also checks the
    // membership, so a claimed job that races the removal before its session
    // exists cannot start either.
    const outcome = await withSecurityChange(db, tenantId, afterSecurityChange, async (client, change) => {
      // Same lock order as every other manager change: the tenant's
      // membership lock, then identity, then the member's chats (the removal
      // takes their sandboxes), then membership, then scheduled jobs.
      await lockTenantMembership(client, tenantId);
      await lockLocalIdentityForMembershipChange(client, tenantId, targetUserId);
      await change.lockChatsBeforeMembership(targetUserId);
      const target = await client.query(
        `SELECT role, user_auth_source FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE`,
        [tenantId, targetUserId]
      );

      if (!target.rows[0]) {
        return { kind: "missing" as const };
      }

      // The caller's role as committed now (services/member-authority.ts).
      const actorRole = await currentRole(client, tenantId, { userId: request.auth.userId, securityVersion: request.auth.session?.securityVersion });
      if (!isManager(actorRole)) {
        return { kind: "not_a_manager" as const };
      }

      if (target.rows[0].role === "owner") {
        return { kind: "cannot_remove_owner" as const };
      }

      // Same rule as the role change: an admin who could remove peers could
      // strip every other admin and entrench themselves as the only one.
      if (target.rows[0].role === "admin" && actorRole !== "owner") {
        return { kind: "only_owner_can_remove_admin" as const };
      }

      // Disable the removed member's scheduled jobs in the same transaction as
      // the membership delete. Left enabled, they keep firing as synthetic
      // turns under the removed user's identity, using their stored OAuth
      // tokens — the membership row is not consulted anywhere on the scheduler
      // path. `next_run_at = NULL` also drops them out of the due-job query.
      // The pause reason makes the owner review each job before it runs
      // again, if the member comes back.
      await client.query(
        `UPDATE scheduled_jobs
         SET enabled = FALSE, next_run_at = NULL, paused_reason = 'security_change', updated_at = NOW()
         WHERE tenant_id = $1 AND user_id = $2`,
        [tenantId, targetUserId]
      );

      // A local account has no other tenant: removal ends it for good. The
      // identity row stays, marked removed, for audit references.
      if (target.rows[0].user_auth_source === "local") {
        await markLocalIdentityRemoved(change, targetUserId);
      }
      // A WorkOS member has no security version; its work stops all the same.
      change.endActiveWork(targetUserId);

      await client.query(
        `DELETE FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2`,
        [tenantId, targetUserId]
      );
      await AuditEventStore.createInTransaction(client, tenantAudit(request, "tenant.member.removed", {
        targetUserId,
        previousRole: target.rows[0].role
      }));

      return { kind: "deleted" as const };
    });

    if (outcome.kind === "missing") {
      return reply.code(404).send({ error: "member_not_found" });
    }

    if (outcome.kind === "cannot_remove_owner") {
      return reply.code(403).send({ error: "cannot_remove_owner" });
    }

    if (outcome.kind === "only_owner_can_remove_admin") {
      return reply.code(403).send({ error: "only_owner_can_remove_admin" });
    }

    if (outcome.kind === "not_a_manager") {
      return reply.code(403).send({ error: "forbidden", message: "Insufficient permissions" });
    }

    // Revoke the removed member's stored OAuth connections. This runs AFTER the
    // membership transaction, not inside it: each connection service opens its
    // own `withTenantScope` and writes an audit event, so it cannot join the
    // client above. A crash in the gap leaves connection rows for a user who is
    // no longer a member — they are unreachable while the membership is gone,
    // but note that a later re-add through WorkOS provisioning recreates the
    // membership and would restore access to them.
    //
    // Driven off the integration registry rather than a hardcoded table list so
    // a private overlay's integrations are covered too.
    for (const descriptor of integrationDescriptors.list()) {
      const revoke = descriptor.connectionProbe?.deleteConnection;
      if (!revoke) continue;
      try {
        await revoke.call(descriptor.connectionProbe, tenantId, targetUserId);
      } catch (error) {
        // One failing integration must not strand the others, and the member is
        // already removed. Log and continue; the row is unreachable meanwhile.
        request.log.error(
          { err: error, integrationId: descriptor.id, tenantId, userId: targetUserId },
          "member removal: failed to revoke integration connection"
        );
      }
    }

    return reply.send({ ok: true });
  });
}
