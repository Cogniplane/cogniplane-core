import { isLoginTypeEnabled, loadConfig } from "../config.js";
import { createPrivilegedDatabase } from "../lib/db.js";
import { bootstrapLocalTenant, parseBootstrapArguments } from "./local-auth-commands-lib.js";

// Creates a local tenant and its first owner, and prints the setup link.
// pnpm --filter @cogniplane/backend auth:bootstrap --tenant-name "Acme" --owner-email ceo@acme.test

async function run(): Promise<void> {
  const args = parseBootstrapArguments(process.argv.slice(2));
  const databaseUrl = process.env.MIGRATION_DATABASE_URL;
  if (!databaseUrl) throw new Error("MIGRATION_DATABASE_URL is required; auth:bootstrap cannot run as app_user.");
  const config = loadConfig(process.env, undefined, { skipRuntimeChecks: true });
  if (config.AUTH_MODE !== "jwt" || !isLoginTypeEnabled(config, "local")) {
    throw new Error("Local login is not enabled: set AUTH_MODE=jwt and add local to AUTH_LOGIN_TYPES.");
  }

  const db = createPrivilegedDatabase(databaseUrl);
  try {
    const result = await bootstrapLocalTenant(db, config.API_ORIGIN, args);
    console.log(JSON.stringify({
      tenantId: result.tenantId,
      ownerUserId: result.userId,
      setupLink: result.link.url,
      expiresAt: result.link.expiresAt
    }, null, 2));
  } finally {
    await db.end();
  }
}

await run();
