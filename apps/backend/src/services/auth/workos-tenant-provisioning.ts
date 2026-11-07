import type { WorkOS } from "@workos-inc/node";

import type { Pool } from "../../lib/db.js";
import { withTransaction } from "../../lib/db.js";
import { uuidv7 } from "../../lib/uuid.js";

/**
 * Raised when the email on an incoming WorkOS login already belongs to a
 * different WorkOS identity. The login cannot proceed without taking over that
 * account, so the route answers 409.
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
 * Raised when a WorkOS login resolves to a tenant whose members do not sign
 * in through WorkOS. The provisioning transaction rolls back, so nothing is
 * written (docs/ARCHITECTURE.md, "Authentication").
 */
export class WrongLoginTypeError extends Error {
  readonly organizationId: string;

  constructor(organizationId: string) {
    super(`The tenant of WorkOS organization ${organizationId} does not use WorkOS login`);
    this.name = "WrongLoginTypeError";
    this.organizationId = organizationId;
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
       RETURNING tenant_id, login_type`,
      [uuidv7(), input.organizationName, input.organizationId.toLowerCase(), input.organizationId]
    );
    const tenantId = tenantResult.rows[0].tenant_id as string;
    // Checked inside the transaction, after the upsert has locked the tenant
    // row: a throw here rolls back every write of this login.
    if (tenantResult.rows[0].login_type !== "workos") {
      throw new WrongLoginTypeError(input.organizationId);
    }

    // `users` is unique on BOTH workos_user_id and email, but the upsert below
    // can only name one conflict target. A WorkOS user that was deleted and
    // re-created reuses the email under a new workos_user_id, so the INSERT
    // conflicts on the email constraint the ON CONFLICT clause does not cover
    // and raises 23505 — a 500 on a legitimate login.
    //
    // Serialize on the email key before touching the row. An advisory lock, not
    // SELECT ... FOR UPDATE: FOR UPDATE locks nothing when it matches no rows,
    // so two concurrent first-logins would both fall through to the INSERT. The
    // lock is transaction-scoped and releases on commit or rollback. The key is
    // computed by Postgres, the same way as the users.email_key column, so
    // every login path locks the same value for one person.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('users:email_key:' || lower(btrim($1))))`, [
      input.email
    ]);

    // Match on users.email_key (lowercase, trimmed), which is also the unique
    // key, so 'Alice@example.com' finds the row of 'alice@example.com'.
    const emailOwner = await client.query(
      `SELECT user_id, workos_user_id, auth_source FROM users WHERE email_key = lower(btrim($1)) LIMIT 1`,
      [input.email]
    );
    const emailOwnerRow = emailOwner.rows[0] as
      | { user_id: string; workos_user_id: string | null; auth_source?: string }
      | undefined;

    // The email row is ours only when it is already bound to this WorkOS
    // identity. Any other row is refused, also one with workos_user_id NULL:
    // binding such a row would hand its data to whoever signs in with that
    // email, without proof that the email is verified or that the row belongs
    // to this organization's tenant. Local users (auth_source 'local') always
    // have workos_user_id NULL. See docs/ARCHITECTURE.md, "Authentication".
    if (
      emailOwnerRow &&
      (emailOwnerRow.auth_source === "local" || emailOwnerRow.workos_user_id !== input.workosUserId)
    ) {
      throw new WorkOsEmailConflictError(input.email);
    }

    // The code updates an existing email row in place and does not re-insert it.
    // The INSERT below would conflict on the email constraint, which its ON
    // CONFLICT target does not cover.
    const userId = emailOwnerRow
      ? ((
          await client.query(
            `UPDATE users
             SET workos_user_id = $2, display_name = $3, updated_at = NOW()
             WHERE user_id = $1
             RETURNING user_id`,
            [emailOwnerRow.user_id, input.workosUserId, input.displayName]
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

    // Count members before the membership upsert. Concurrent first logins
    // to one tenant wait for each other on the tenant row that the upsert
    // above locked, so only one of them sees zero.
    const memberCount = await client.query(
      `SELECT COUNT(*) AS cnt FROM tenant_memberships WHERE tenant_id = $1`,
      [tenantId]
    );
    const isFirstMember = Number(memberCount.rows[0].cnt) === 0;

    // The role of a new membership. An existing membership keeps its role
    // (resolveTenantMembershipRole), so the upsert never writes `role` on a
    // conflict: it returns the role as committed now. Reading the role first
    // and writing it back would undo a role change that commits in between:
    // ON CONFLICT DO UPDATE waits for the row and acts on its latest version,
    // a separate read does not. A removal that commits in between leaves no
    // row, so the login inserts a new membership with this role, as a login
    // just after the removal would.
    const newMemberRole = resolveTenantMembershipRole({
      existingRole: null,
      isFirstMember,
      workosRoleSlug: input.workosRoleSlug
    });
    const membership = await client.query<{ role: "owner" | "admin" | "member"; inserted: boolean }>(
      `INSERT INTO tenant_memberships (tenant_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET
         updated_at = NOW()
       RETURNING role, (xmax = 0) AS inserted`,
      [tenantId, userId, newMemberRole]
    );
    const { role, inserted } = membership.rows[0]!;

    // An existing membership is unchanged, so its previous role is its role.
    return { tenantId, userId, role, previousRole: inserted ? undefined : role };
  });
}
