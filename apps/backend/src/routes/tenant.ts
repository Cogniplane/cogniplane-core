import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { TenantDetailsSchema } from "@cogniplane/shared-types";

import type { Pool } from "../lib/db.js";
import { withTenantScope } from "../lib/db.js";
import { requireRole } from "../lib/rbac.js";
import { parseRequestInput } from "../lib/route-validation.js";
import { serialize } from "../lib/serialize-response.js";
import { httpsUrlSchema } from "../lib/url-validation.js";
import type { GithubConnectionService } from "../services/integrations/github/github-connection-service.js";
import { piiProtectionSchema } from "../services/pii/pii-policy.js";
import type { TenantOrgSettingsStore } from "../services/tenant-org-settings-store.js";

const tenantUpdateSchema = z.object({
  tenantName: z.string().trim().min(1).max(200).optional()
});

const apiKeysSchema = z.object({
  openaiApiKey: z.string().optional(),
  anthropicApiKey: z.string().optional()
});

const marketplaceSchema = z.object({
  skillMarketplaceManifestUrl: z.string().nullable().optional()
});

const memberRoleSchema = z.object({
  role: z.string()
});

export async function registerTenantRoutes(
  app: FastifyInstance,
  {
    db,
    tenantOrgSettings,
    githubConnections,
    getMicrosoftConfigured
  }: {
    db: Pool;
    tenantOrgSettings: TenantOrgSettingsStore;
    githubConnections?: GithubConnectionService;
    // Optional callback supplied by the SharePoint private overlay. Returns
    // whether the tenant has a Microsoft OAuth app configured. When absent
    // (OSS subset, no overlay), the response carries `configured: false`.
    getMicrosoftConfigured?: (tenantId: string, userId: string) => Promise<boolean>;
  }
): Promise<void> {
  // Get tenant details
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

    return reply.send(serialize(TenantDetailsSchema, {
      tenantId: row.tenant_id,
      tenantName: row.tenant_name,
      slug: row.slug,
      ssoProvider: row.sso_provider,
      plan: row.plan,
      settings: {
        openaiApiKeyConfigured: orgSettings.hasOpenaiApiKey,
        anthropicApiKeyConfigured: orgSettings.hasAnthropicApiKey,
        skillMarketplaceManifestUrl: orgSettings.skillMarketplaceManifestUrl,
        piiProtection: orgSettings.piiProtection,
        github: {
          configured: githubStatus.configured
        },
        microsoftOAuth: {
          configured: getMicrosoftConfigured
            ? await getMicrosoftConfigured(tenantId, request.auth.userId)
            : false
        }
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  });

  // Update tenant settings (owner only)
  app.put("/tenant", async (request, reply) => {
    if (!requireRole(request, reply, "owner")) return;

    const { tenantId } = request.auth;
    const parsed = parseRequestInput(reply, tenantUpdateSchema, request.body);
    if (!parsed.ok) return parsed.response;
    const { tenantName } = parsed.value;

    const updates: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (tenantName) {
      updates.push(`tenant_name = $${paramIndex++}`);
      values.push(tenantName);
    }

    if (updates.length === 0) {
      return reply.code(400).send({ error: "no_updates" });
    }

    updates.push(`updated_at = NOW()`);
    values.push(tenantId);

    const result = await withTenantScope(db, tenantId, (client) =>
      client.query(
        `UPDATE tenants SET ${updates.join(", ")} WHERE tenant_id = $${paramIndex}
         RETURNING tenant_id, tenant_name, slug, plan, updated_at`,
        values
      )
    );

    return reply.send(result.rows[0]);
  });

  // Update tenant settings (owner only)
  app.put("/tenant/settings", async (request, reply) => {
    if (!requireRole(request, reply, "owner")) return;

    const { tenantId } = request.auth;
    const parsed = parseRequestInput(reply, apiKeysSchema, request.body);
    if (!parsed.ok) return parsed.response;
    const { openaiApiKey, anthropicApiKey } = parsed.value;

    const trimmedOpenai = openaiApiKey?.trim() || undefined;
    const trimmedAnthropic = anthropicApiKey?.trim() || undefined;
    if (!trimmedOpenai && !trimmedAnthropic) {
      return reply.code(400).send({ error: "api_key_required" });
    }

    await tenantOrgSettings.setApiKeys(tenantId, {
      openaiApiKey: trimmedOpenai,
      anthropicApiKey: trimmedAnthropic
    });

    return reply.send({
      ok: true,
      openaiApiKeyConfigured: Boolean(trimmedOpenai),
      anthropicApiKeyConfigured: Boolean(trimmedAnthropic)
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

    // Normalize: empty string → null
    const value = (url === null || url === undefined || url.trim() === "") ? null : url.trim();

    await tenantOrgSettings.setMarketplaceUrl(tenantId, value);

    return reply.send({ ok: true, skillMarketplaceManifestUrl: value });
  });

  // Update org PII protection settings (owner/admin only)
  app.put("/tenant/settings/pii", async (request, reply) => {
    if (!requireRole(request, reply, "owner", "admin")) return;

    const parsed = piiProtectionSchema.safeParse(request.body);
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
    await tenantOrgSettings.setPiiProtection(tenantId, parsed.data);

    return reply.send({ ok: true, piiProtection: parsed.data });
  });

  // List tenant members (owner/admin only)
  app.get("/tenant/members", async (request, reply) => {
    if (!requireRole(request, reply, "owner", "admin")) return;

    const { tenantId } = request.auth;

    const result = await db.query(
      `SELECT u.user_id, u.email, u.display_name, tm.role, tm.created_at
       FROM tenant_memberships tm
       JOIN users u ON u.user_id = tm.user_id
       WHERE tm.tenant_id = $1
       ORDER BY tm.created_at ASC`,
      [tenantId]
    );

    return reply.send(
      result.rows.map((row) => ({
        userId: row.user_id,
        email: row.email,
        displayName: row.display_name,
        role: row.role,
        joinedAt: row.created_at
      }))
    );
  });

  // Update member role (owner/admin only, cannot demote owner)
  app.put("/tenant/members/:userId/role", async (request, reply) => {
    if (!requireRole(request, reply, "owner", "admin")) return;

    const { tenantId } = request.auth;
    const targetUserId = (request.params as { userId: string }).userId;
    const parsed = parseRequestInput(reply, memberRoleSchema, request.body);
    if (!parsed.ok) return parsed.response;
    const { role } = parsed.value;

    if (!["owner", "admin", "member"].includes(role)) {
      return reply.code(400).send({ error: "invalid_role" });
    }

    // Only owners can assign the owner role
    if (role === "owner" && request.auth.role !== "owner") {
      return reply.code(403).send({ error: "only_owner_can_assign_owner" });
    }

    // Cannot change your own role
    if (targetUserId === request.auth.userId) {
      return reply.code(400).send({ error: "cannot_change_own_role" });
    }

    const outcome = await withTenantScope(db, tenantId, async (client) => {
      const target = await client.query(
        `SELECT role FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE`,
        [tenantId, targetUserId]
      );

      if (!target.rows[0]) {
        return { kind: "missing" as const };
      }

      if (target.rows[0].role === "owner" && role !== "owner") {
        return { kind: "cannot_demote_owner" as const };
      }

      const result = await client.query(
        `UPDATE tenant_memberships SET role = $1, updated_at = NOW()
          WHERE tenant_id = $2 AND user_id = $3
          RETURNING tenant_id, user_id, role`,
        [role, tenantId, targetUserId]
      );

      return { kind: "updated" as const, row: result.rows[0] };
    });

    if (outcome.kind === "missing") {
      return reply.code(404).send({ error: "member_not_found" });
    }

    if (outcome.kind === "cannot_demote_owner") {
      return reply.code(403).send({ error: "cannot_demote_owner" });
    }

    return reply.send(outcome.row);
  });

  // Remove member (owner/admin only)
  app.delete("/tenant/members/:userId", async (request, reply) => {
    if (!requireRole(request, reply, "owner", "admin")) return;

    const { tenantId } = request.auth;
    const targetUserId = (request.params as { userId: string }).userId;

    // Cannot remove yourself
    if (targetUserId === request.auth.userId) {
      return reply.code(400).send({ error: "cannot_remove_self" });
    }

    const outcome = await withTenantScope(db, tenantId, async (client) => {
      const target = await client.query(
        `SELECT role FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE`,
        [tenantId, targetUserId]
      );

      if (!target.rows[0]) {
        return { kind: "missing" as const };
      }

      if (target.rows[0].role === "owner") {
        return { kind: "cannot_remove_owner" as const };
      }

      await client.query(
        `DELETE FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2`,
        [tenantId, targetUserId]
      );

      return { kind: "deleted" as const };
    });

    if (outcome.kind === "missing") {
      return reply.code(404).send({ error: "member_not_found" });
    }

    if (outcome.kind === "cannot_remove_owner") {
      return reply.code(403).send({ error: "cannot_remove_owner" });
    }

    return reply.send({ ok: true });
  });
}
