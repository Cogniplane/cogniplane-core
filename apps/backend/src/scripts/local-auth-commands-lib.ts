import { randomBytes } from "node:crypto";

import { type Pool, withTransaction } from "../lib/db.js";
import { PasswordHasher } from "../lib/password-hash.js";
import { uuidv7 } from "../lib/uuid.js";
import { type IssuedLink, LocalAccountService } from "../services/auth/local-account-service.js";
import { NO_RUNTIMES_IN_THIS_PROCESS } from "../services/auth/security-change.js";

// Operator commands for local login (docs/architecture/local-accounts.md).
// They run on MIGRATION_DATABASE_URL, like tenant:delete, and print a one-time
// link for the person to open.

function parseFlags(argv: string[], allowed: readonly string[], usage: string): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    // A repeated flag must not silently replace the first one.
    if (!flag || !allowed.includes(flag) || values.has(flag) || !value || value.startsWith("--")) {
      throw new Error(usage);
    }
    values.set(flag, value);
  }
  return values;
}

export type BootstrapArguments = { tenantName: string; ownerEmail: string; ownerName: string | null };

const BOOTSTRAP_USAGE =
  "Usage: auth:bootstrap --tenant-name <name> --owner-email <email> [--owner-name <name>]";

export function parseBootstrapArguments(argv: string[]): BootstrapArguments {
  const values = parseFlags(argv, ["--tenant-name", "--owner-email", "--owner-name"], BOOTSTRAP_USAGE);
  const tenantName = values.get("--tenant-name")?.trim();
  const ownerEmail = values.get("--owner-email")?.trim();
  if (!tenantName || !ownerEmail || tenantName.length > 200) throw new Error(BOOTSTRAP_USAGE);
  return { tenantName, ownerEmail, ownerName: values.get("--owner-name")?.trim() || null };
}

export type RecoverOwnerArguments = { tenantId: string; email: string };

const RECOVER_USAGE = "Usage: auth:recover-owner --tenant-id <id> --email <owner email>";

export function parseRecoverOwnerArguments(argv: string[]): RecoverOwnerArguments {
  const values = parseFlags(argv, ["--tenant-id", "--email"], RECOVER_USAGE);
  const tenantId = values.get("--tenant-id")?.trim();
  const email = values.get("--email")?.trim();
  if (!tenantId || !email) throw new Error(RECOVER_USAGE);
  return { tenantId, email };
}

function slugFor(name: string): string {
  const base = name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  // A random suffix keeps slugs unique without a lookup race.
  return `${base || "tenant"}-${randomBytes(3).toString("hex")}`;
}

export function operatorAccountService(db: Pool, frontendOrigin: string): LocalAccountService {
  // The commands never hash a password; one slot is enough. No mail queue:
  // the commands always print the link for the operator, also with email on.
  // The command cannot stop runtimes of the servers. After a recovery, the
  // gateway refuses the tool calls of the owner's older turns on every
  // server (services/auth/security-change.ts).
  return new LocalAccountService({
    db, lookupDb: db, hasher: new PasswordHasher(1), frontendOrigin, afterSecurityChange: NO_RUNTIMES_IN_THIS_PROCESS
  });
}

/**
 * Creates a local tenant and its first owner in one transaction, and returns
 * the owner's setup link. The tenant's login type is fixed from now on.
 */
export async function bootstrapLocalTenant(
  db: Pool,
  frontendOrigin: string,
  args: BootstrapArguments
): Promise<{ tenantId: string; userId: string; link: IssuedLink }> {
  const accounts = operatorAccountService(db, frontendOrigin);
  return withTransaction(db, async (client) => {
    const tenantId = uuidv7();
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
    await client.query(
      `INSERT INTO tenants (tenant_id, tenant_name, slug, login_type) VALUES ($1, $2, $3, 'local')`,
      [tenantId, args.tenantName, slugFor(args.tenantName)]
    );
    const created = await accounts.createMemberInTransaction(client, {
      tenantId,
      email: args.ownerEmail,
      displayName: args.ownerName,
      role: "owner",
      actorUserId: null,
      meta: { ipAddress: null, userAgent: null }
    });
    // Without a mail queue the service always returns the link.
    if (!created.link) throw new Error("The setup link was not returned.");
    return { tenantId, userId: created.userId, link: created.link };
  });
}
