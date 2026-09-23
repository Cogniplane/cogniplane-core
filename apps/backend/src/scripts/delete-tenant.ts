import { Redis } from "ioredis";

import { loadConfig } from "../config.js";
import { createPrivilegedDatabase } from "../lib/db.js";
import { createArtifactStorage } from "../services/artifacts/artifact-storage.js";
import { createDeepAgentsCheckpointer } from "../services/deep-agents/deep-agents-checkpointer.js";
import { createSkillBundleStorage } from "../services/skills/skill-bundle-storage.js";
import { TenantDeletionService } from "../services/tenant-deletion-service.js";

type Arguments = {
  tenantId: string;
  confirm: string;
  requestId: string;
  thirdPartyDisposition: string;
  backupDisposition: string;
  maintenanceConfirmed: boolean;
};

function usage(): never {
  throw new Error(
    "Usage: delete-tenant --tenant-id <id> --confirm <same-id> --request-id <ticket> " +
      "--third-party-disposition <text> --backup-disposition <text> --maintenance-confirmed"
  );
}

function parseArguments(argv: string[]): Arguments {
  const values = new Map<string, string>();
  let maintenanceConfirmed = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--maintenance-confirmed") {
      maintenanceConfirmed = true;
      continue;
    }
    if (!flag?.startsWith("--")) usage();
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) usage();
    values.set(flag, value);
    index += 1;
  }

  const tenantId = values.get("--tenant-id");
  const confirm = values.get("--confirm");
  const requestId = values.get("--request-id");
  const thirdPartyDisposition = values.get("--third-party-disposition");
  const backupDisposition = values.get("--backup-disposition");
  if (!tenantId || !confirm || !requestId || !thirdPartyDisposition || !backupDisposition) usage();
  return {
    tenantId,
    confirm,
    requestId,
    thirdPartyDisposition,
    backupDisposition,
    maintenanceConfirmed
  };
}

async function run(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (args.confirm !== args.tenantId) {
    throw new Error("--confirm must exactly match --tenant-id.");
  }
  if (!args.maintenanceConfirmed) {
    throw new Error(
      "--maintenance-confirmed is required after the backend has stopped gracefully and database writes are quiesced."
    );
  }

  const databaseUrl = process.env.MIGRATION_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("MIGRATION_DATABASE_URL is required; tenant deletion cannot run as app_user.");
  }
  const config = loadConfig(process.env, undefined, { skipRuntimeChecks: true });
  const db = createPrivilegedDatabase(databaseUrl);
  const checkpointer = createDeepAgentsCheckpointer(databaseUrl);
  const redis = config.REDIS_URL
    ? new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: true })
    : null;

  try {
    const service = new TenantDeletionService({
      db,
      artifactStorage: createArtifactStorage(config),
      skillBundleStorage: createSkillBundleStorage(config),
      purgeRuntimeThread: (threadId) => checkpointer.deleteThread(threadId),
      flushRedis: redis ? () => redis.flushdb().then(() => undefined) : undefined
    });
    const receipt = await service.execute({
      requestId: args.requestId,
      tenantId: args.tenantId,
      redisDisposition: redis
        ? "Dedicated environment Redis database flushed; all sessions and rate-limit state invalidated."
        : "REDIS_URL was not configured; no external Redis data existed.",
      thirdPartyDisposition: args.thirdPartyDisposition,
      backupDisposition: args.backupDisposition
    });
    console.log(JSON.stringify(receipt, null, 2));
    if (receipt.status !== "completed") process.exitCode = 1;
  } finally {
    await Promise.allSettled([db.end(), checkpointer.end(), redis?.quit()]);
  }
}

await run();
