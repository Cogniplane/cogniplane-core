import type { WorkOS } from "@workos-inc/node";

import type { Pool } from "../../lib/db.js";
import { withTransaction } from "../../lib/db.js";
import { uuidv7 } from "../../lib/uuid.js";

/**
 * Raised when the email on an incoming WorkOS login already belongs to a
 * different WorkOS identity. The login cannot proceed without taking over that
 * account, so the route answers 409 instead of the 23505-driven 500 this
 * replaces.
 */
export class WorkOsEmailConflictError extends Error {
  readonly email: string;

  constructor(email: string) {
    super(`Email already bound to a different WorkOS identity: ${email}`);
    this.name = "WorkOsEmailConflictError";
    this.email = email;
  }
}

/**
 * The tenant's own RBAC is authoritative once a membership exists. WorkOS seeds
 * the role at first provisioning only — re-applying the org role slug on every
 * login would undo an in-app demotion (a revoked admin returns at next login)
 * and silently reverse an in-app promotion. Role changes after provisioning go
 * through PUT /tenant/members/:userId/role.
 */
export function resolveTenantMembershipRole(input: {
  existingRole: string | null;
  isFirstMember: boolean;
  workosRoleSlug: string | null | undefined;
}): "owner" | "admin" | "member" {
  if (input.existingRole === "owner" || input.existingRole === "admin" || input.existingRole === "member") {
    return input.existingRole;
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
      // tenant_name is deliberately NOT in the DO UPDATE list. The owner renames
      // the tenant through PUT /tenant; re-applying the WorkOS org name on every
      // member's login would revert that rename at the next sign-in. The name is
      // seeded once, on INSERT. A later rename in WorkOS therefore does not sync.
      `INSERT INTO tenants (tenant_id, tenant_name, slug, workos_org_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (workos_org_id) DO UPDATE SET
         updated_at = NOW()
       RETURNING tenant_id`,
      [uuidv7(), input.organizationName, input.organizationId.toLowerCase(), input.organizationId]
    );
    const tenantId = tenantResult.rows[0].tenant_id as string;

    // `users` is unique on BOTH workos_user_id and email, but the upsert below
    // can only name one conflict target. A WorkOS user that was deleted and
    // re-created reuses the email under a new workos_user_id, so the INSERT
    // conflicts on the email constraint the ON CONFLICT clause does not cover
    // and raises 23505 — a 500 on a legitimate login.
    //
    // Serialize on the email before touching the row. An advisory lock, not
    // SELECT ... FOR UPDATE: FOR UPDATE locks nothing when it matches no rows,
    // so two concurrent first-logins would both fall through to the INSERT. The
    // lock is transaction-scoped and releases on commit or rollback.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `users:email:${input.email}`
    ]);

    // Match the email exactly. The UNIQUE constraint is case-sensitive, so a
    // case-insensitive lookup here would find a row the INSERT could still
    // collide with.
    const emailOwner = await client.query(
      `SELECT user_id, workos_user_id FROM users WHERE email = $1 LIMIT 1`,
      [input.email]
    );
    const emailOwnerWorkosId = emailOwner.rows[0]?.workos_user_id as string | null | undefined;

    // Rebind the email to the incoming WorkOS identity only when it is unclaimed
    // or already this identity. An email held by a DIFFERENT non-null
    // workos_user_id is not ours to take: if WorkOS ever recycles an address
    // across identities, silently rebinding would hand one person another's
    // account.
    if (emailOwner.rows[0] && emailOwnerWorkosId && emailOwnerWorkosId !== input.workosUserId) {
      throw new WorkOsEmailConflictError(input.email);
    }

    // An existing email row is updated in place rather than re-inserted: the
    // INSERT below would conflict on the email constraint, which the ON CONFLICT
    // target does not cover. This is the re-created-WorkOS-user path, and it is
    // also how an unclaimed (workos_user_id IS NULL) row gets bound.
    const userId = emailOwner.rows[0]
      ? ((
          await client.query(
            `UPDATE users
             SET workos_user_id = $2, display_name = $3, updated_at = NOW()
             WHERE user_id = $1
             RETURNING user_id`,
            [emailOwner.rows[0].user_id, input.workosUserId, input.displayName]
          )
        ).rows[0].user_id as string)
      : ((
          await client.query(
            `INSERT INTO users (user_id, email, display_name, workos_user_id)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (workos_user_id) DO UPDATE SET
               email = EXCLUDED.email,
               display_name = EXCLUDED.display_name,
               updated_at = NOW()
             RETURNING user_id`,
            [uuidv7(), input.email, input.displayName, input.workosUserId]
          )
        ).rows[0].user_id as string);

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
