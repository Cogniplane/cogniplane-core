import { Redis } from "ioredis";

import { loadConfig } from "../config.js";
import { createPrivilegedDatabase } from "../lib/db.js";
import { createArtifactStorage } from "../services/artifacts/artifact-storage.js";
import { createDeepAgentsCheckpointer } from "../services/deep-agents/deep-agents-checkpointer.js";
import { createSkillBundleStorage } from "../services/skills/skill-bundle-storage.js";
import { TenantDeletionService } from "../services/tenant-deletion-service.js";
import { parseDeleteTenantArguments } from "./delete-tenant-lib.js";

async function run(): Promise<void> {
  const args = parseDeleteTenantArguments(process.argv.slice(2));

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
