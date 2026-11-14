import { Redis } from "ioredis";

import { loadConfig } from "../config.js";
import { createPrivilegedDatabase } from "../lib/db.js";
import { createArtifactStorage } from "../services/artifacts/artifact-storage.js";
import { createDeepAgentsCheckpointer } from "../services/deep-agents/deep-agents-checkpointer.js";
import { createSkillBundleStorage } from "../services/skills/skill-bundle-storage.js";
import {
  REDIS_DISPOSITION,
  TenantDeletionService,
  type TenantDeletionReceipt
} from "../services/tenant-deletion-service.js";

export type DeleteTenantArguments = {
  tenantId: string;
  requestId: string;
  thirdPartyDisposition: string;
  backupDisposition: string;
  /** Flush the whole Redis database of REDIS_URL, for every tenant. */
  flushRedis: boolean;
};

const VALUE_FLAGS = new Set([
  "--tenant-id",
  "--confirm",
  "--request-id",
  "--third-party-disposition",
  "--backup-disposition"
]);
const BARE_FLAGS = new Set(["--maintenance-confirmed", "--flush-redis"]);

function usage(): never {
  throw new Error(
    "Usage: delete-tenant --tenant-id <id> --confirm <same-id> --request-id <ticket> " +
      "--third-party-disposition <text> --backup-disposition <text> --maintenance-confirmed [--flush-redis]"
  );
}

/**
 * Parse and check the delete-tenant command line. It refuses to go on unless
 * --confirm repeats the tenant id and the operator confirms that the backend
 * is stopped, so a typo cannot delete the wrong tenant or a live one. Unknown
 * and repeated flags are refused too: a mistyped "--dry-run yes" must not run
 * a real deletion, and a second --tenant-id must not replace the first. The
 * bare flags take no value, so "--flush-redis yes" is refused.
 */
export function parseDeleteTenantArguments(argv: string[]): DeleteTenantArguments {
  const values = new Map<string, string>();
  const bare = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag && BARE_FLAGS.has(flag)) {
      if (bare.has(flag)) usage();
      bare.add(flag);
      continue;
    }
    if (!flag || !VALUE_FLAGS.has(flag) || values.has(flag)) usage();
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
  if (confirm !== tenantId) {
    throw new Error("--confirm must exactly match --tenant-id.");
  }
  if (!bare.has("--maintenance-confirmed")) {
    throw new Error(
      "--maintenance-confirmed is required after the backend has stopped gracefully and database writes are quiesced."
    );
  }
  return {
    tenantId,
    requestId,
    thirdPartyDisposition,
    backupDisposition,
    flushRedis: bare.has("--flush-redis")
  };
}

/** The part of the Redis client that --flush-redis uses. */
export type RedisFlushClient = Pick<Redis, "flushdb" | "disconnect">;

export type DeleteTenantOptions = {
  /** Opens Redis for --flush-redis. Tests wrap it to see whether the command opened Redis. */
  connectRedis?: (url: string) => RedisFlushClient;
  /** Receives the receipt. */
  print?: (text: string) => void;
  /** Receives notes for the operator. */
  warn?: (text: string) => void;
};

/**
 * The stderr note about `externalResources` in a receipt, or null when every
 * count is zero. The command deletes only the database rows of these
 * resources, so a completed receipt does not mean that they are gone.
 */
export function externalResourceNotice(receipt: Pick<TenantDeletionReceipt, "externalResources">): string | null {
  const inventory = receipt.externalResources;
  if (!inventory) {
    return "externalResources is null: this receipt is older than the external resource counts, so the counts " +
      "were not recorded. thirdPartyDisposition is the only record of resources outside the database.";
  }
  const { oauthConnections: oauth, jira } = inventory;
  const total = inventory.e2bSandboxes + jira.externalUserIds + jira.pendingCleanups +
    oauth.github + oauth.notion + oauth.microsoft + inventory.personalMcpCredentials;
  if (total === 0) return null;
  return "The tenant had resources outside the database (externalResources in the receipt). tenant:delete " +
    "deleted only their database rows: it killed no E2B sandbox and revoked no Pipedream account, OAuth grant " +
    "or MCP credential. Check each nonzero count at its provider and compare it with thirdPartyDisposition.";
}

function connectRedis(url: string): RedisFlushClient {
  return new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: true });
}

/**
 * Run tenant:delete and return its exit code: 0 for a completed receipt, 1
 * otherwise. `env` is the command's environment, normally `process.env`.
 *
 * The command opens Redis only for --flush-redis. FLUSHDB removes every key in
 * the database that REDIS_URL selects, not only the deleted tenant's keys. The
 * flag cannot be added to a request later: on a replay, it only lets a flush
 * that an earlier run queued run.
 */
export async function runDeleteTenant(
  argv: string[],
  env: NodeJS.ProcessEnv,
  options: DeleteTenantOptions = {}
): Promise<number> {
  const args = parseDeleteTenantArguments(argv);
  const print = options.print ?? ((text: string) => console.log(text));
  const warn = options.warn ?? ((text: string) => console.error(text));

  const databaseUrl = env.MIGRATION_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("MIGRATION_DATABASE_URL is required; tenant deletion cannot run as app_user.");
  }
  const config = loadConfig(env, undefined, { skipRuntimeChecks: true });
  if (args.flushRedis && !config.REDIS_URL) {
    throw new Error("--flush-redis needs REDIS_URL, but REDIS_URL is not configured. Nothing was deleted.");
  }

  const db = createPrivilegedDatabase(databaseUrl);
  const checkpointer = createDeepAgentsCheckpointer(databaseUrl);
  const redis = args.flushRedis && config.REDIS_URL ? (options.connectRedis ?? connectRedis)(config.REDIS_URL) : null;
  let flushStarted = false;

  try {
    const service = new TenantDeletionService({
      db,
      artifactStorage: createArtifactStorage(config),
      skillBundleStorage: createSkillBundleStorage(config),
      purgeRuntimeThread: (threadId) => checkpointer.deleteThread(threadId),
      flushRedis: redis
        ? async () => {
            flushStarted = true;
            await redis.flushdb();
          }
        : undefined
    });
    const receipt = await service.execute({
      requestId: args.requestId,
      tenantId: args.tenantId,
      redisDisposition: args.flushRedis
        ? REDIS_DISPOSITION.flushQueued
        : config.REDIS_URL
          ? REDIS_DISPOSITION.notRequested
          : REDIS_DISPOSITION.notConfigured,
      thirdPartyDisposition: args.thirdPartyDisposition,
      backupDisposition: args.backupDisposition
    });
    print(JSON.stringify(receipt, null, 2));
    const notice = externalResourceNotice(receipt);
    if (notice) warn(notice);
    if (args.flushRedis && !flushStarted) {
      warn(
        `--flush-redis did nothing: request ${args.requestId} has no queued Redis flush, so Redis was not flushed. ` +
          "redisDisposition in the receipt tells what an earlier run did."
      );
    }
    return receipt.status === "completed" ? 0 : 1;
  } finally {
    // disconnect, not quit: quit would connect a client that never sent a command.
    redis?.disconnect();
    await Promise.allSettled([db.end(), checkpointer.end()]);
  }
}
