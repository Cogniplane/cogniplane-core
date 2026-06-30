import type { WorkOS } from "@workos-inc/node";

import type { Pool } from "../../lib/db.js";
import { withTransaction } from "../../lib/db.js";
import { uuidv7 } from "../../lib/uuid.js";

export function resolveTenantMembershipRole(input: {
  existingRole: string | null;
  isFirstMember: boolean;
  workosRoleSlug: string | null | undefined;
}): "owner" | "admin" | "member" {
  if (input.existingRole === "owner") {
    return "owner";
  }

  if (input.isFirstMember) {
    return "owner";
  }

  return input.workosRoleSlug === "admin" ? "admin" : "member";
}

export type WorkOsOrganizationResolution =
  | {
      status: "resolved";
      organizationId: string;
      organizationName: string;
      roleSlug: string | null;
    }
  | { status: "selection_required"; organizations: Array<{ id: string; name: string }> }
  | { status: "no_organization" };

/**
 * A WorkOS organization hint is authoritative only when it matches an actual
 * membership. Without a hint, a single membership is unambiguous; multiple
 * memberships require the user to restart login with an explicit organization
 * rather than silently selecting WorkOS's first result.
 */
export async function resolveWorkOsOrganization(
  workos: WorkOS,
  input: { workosUserId: string; organizationIdHint: string | null | undefined }
): Promise<WorkOsOrganizationResolution> {
  const memberships = await workos.userManagement.listOrganizationMemberships({
    userId: input.workosUserId
  });

  if (!input.organizationIdHint && memberships.data.length > 1) {
    const organizations = await Promise.all(
      memberships.data.map(async (membership) => {
        const organization = await workos.organizations.getOrganization(
          membership.organizationId
        );
        return { id: organization.id, name: organization.name };
      })
    );
    return { status: "selection_required", organizations };
  }

  const membership = input.organizationIdHint
    ? memberships.data.find((m) => m.organizationId === input.organizationIdHint)
    : memberships.data[0];

  if (!membership) {
    return { status: "no_organization" };
  }

  const organization = await workos.organizations.getOrganization(membership.organizationId);
  return {
    status: "resolved",
    organizationId: organization.id,
    organizationName: organization.name,
    roleSlug: membership.role?.slug ?? null
  };
}

export interface ProvisionedTenantIdentity {
  tenantId: string;
  userId: string;
  role: "owner" | "admin" | "member";
  previousRole: string | undefined;
}

/**
 * Upserts the tenant, user, and membership rows for a WorkOS login. The whole
 * upsert runs in a single transaction to prevent race conditions in
 * first-member owner promotion.
 */
export async function provisionTenantIdentity(
  db: Pool,
  input: {
    organizationId: string;
    organizationName: string;
    workosUserId: string;
    email: string;
    displayName: string;
    workosRoleSlug: string | null;
  }
): Promise<ProvisionedTenantIdentity> {
  return withTransaction(db, async (client) => {
    const tenantResult = await client.query(
      `INSERT INTO tenants (tenant_id, tenant_name, slug, workos_org_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (workos_org_id) DO UPDATE SET
         tenant_name = EXCLUDED.tenant_name,
         updated_at = NOW()
       RETURNING tenant_id`,
      [uuidv7(), input.organizationName, input.organizationId.toLowerCase(), input.organizationId]
    );
    const tenantId = tenantResult.rows[0].tenant_id as string;

    const userResult = await client.query(
      `INSERT INTO users (user_id, email, display_name, workos_user_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (workos_user_id) DO UPDATE SET
         email = EXCLUDED.email,
         display_name = EXCLUDED.display_name,
         updated_at = NOW()
       RETURNING user_id`,
      [uuidv7(), input.email, input.displayName, input.workosUserId]
    );
    const userId = userResult.rows[0].user_id as string;

    // Check member count before upserting membership — inside the same
    // transaction to prevent concurrent first-login races.
    const memberCount = await client.query(
      `SELECT COUNT(*) AS cnt FROM tenant_memberships WHERE tenant_id = $1`,
      [tenantId]
    );
    const isFirstMember = Number(memberCount.rows[0].cnt) === 0;

    const existingMembership = await client.query(
      `SELECT role FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2 LIMIT 1`,
      [tenantId, userId]
    );
    const previousRole = existingMembership.rows[0]?.role as string | undefined;
    const role = resolveTenantMembershipRole({
      existingRole: previousRole ?? null,
      isFirstMember,
      workosRoleSlug: input.workosRoleSlug
    });

    await client.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET
         role = EXCLUDED.role,
         updated_at = NOW()`,
      [tenantId, userId, role]
    );

    return { tenantId, userId, role, previousRole };
  });
}
