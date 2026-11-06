import { loadConfig } from "../config.js";
import { createPrivilegedDatabase } from "../lib/db.js";
import { operatorAccountService, parseRecoverOwnerArguments } from "./local-auth-commands-lib.js";

// Gives a local owner who lost the password a new setup link. Every session
// and older link of that account ends; the action is audited.
// pnpm --filter @cogniplane/backend auth:recover-owner --tenant-id <id> --email <owner email>

async function run(): Promise<void> {
  const args = parseRecoverOwnerArguments(process.argv.slice(2));
  const databaseUrl = process.env.MIGRATION_DATABASE_URL;
  if (!databaseUrl) throw new Error("MIGRATION_DATABASE_URL is required; auth:recover-owner cannot run as app_user.");
  const config = loadConfig(process.env, undefined, { skipRuntimeChecks: true });

  const db = createPrivilegedDatabase(databaseUrl);
  try {
    const result = await operatorAccountService(db, config.API_ORIGIN).recoverOwner(args.tenantId, args.email);
    console.log(JSON.stringify({ ownerUserId: result.userId, setupLink: result.link.url, expiresAt: result.link.expiresAt }, null, 2));
  } finally {
    await db.end();
  }
}

await run();
