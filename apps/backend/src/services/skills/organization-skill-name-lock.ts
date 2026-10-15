import type { PoolClient } from "pg";

// All organization skill paths that can create or change a displayed name take
// this transaction lock before locking a skill row.
export async function lockOrganizationSkillNames(client: PoolClient, tenantId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [JSON.stringify(["organization-skill-name", tenantId])]);
}
