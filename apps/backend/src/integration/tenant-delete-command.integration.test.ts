import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Redis } from "ioredis";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import { issueRefreshJti } from "../lib/refresh-token-store.js";
import { runDeleteTenant } from "../scripts/delete-tenant-lib.js";
import { RedisRequestLimits } from "../services/redis-request-limits.js";
import { REDIS_DISPOSITION, TenantDeletionService } from "../services/tenant-deletion-service.js";
import { createTestConfig } from "../test-helpers/test-config.js";
import { adminDatabaseUrl, runSuperuserUrl, superuserPool } from "./support/database.js";
import { seedMembership, seedTenant, seedUser } from "./support/fixtures.js";

// The tenant:delete command against a real PostgreSQL and a real Redis. Unit
// tests of the service use a fake pool and a fake flush; they cannot show which
// Redis keys a command run leaves or removes.
//
// The command's REDIS_URL selects TARGET_DB of the test Redis. OTHER_DB stands
// for another environment or service on the same Redis server. Both must be
// empty before the suite starts: a run with --flush-redis erases TARGET_DB.

if (process.env.INTEGRATION_REQUIRE_REDIS === "1" && !process.env.INTEGRATION_REDIS_URL) {
  throw new Error("INTEGRATION_REQUIRE_REDIS=1 but INTEGRATION_REDIS_URL is not set.");
}

const TARGET_DB = 14;
const OTHER_DB = 15;
const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const execFileAsync = promisify(execFile);

function redisUrl(db: number): string {
  const url = new URL(process.env.INTEGRATION_REDIS_URL!);
  url.pathname = `/${db}`;
  return url.toString();
}

type Sentinels = { id: string; jti: string; familyId: string; userId: string; tenantId: string };

/**
 * Writes another tenant's live state with the production helpers: a refresh
 * token family (the member's session) and rate-limit and daily quota counters.
 */
async function seedSentinels(redis: Redis, tenantId: string, userId: string): Promise<Sentinels> {
  const id = randomUUID();
  const sentinels = { id, jti: `${id}-jti`, familyId: `${id}-family`, userId, tenantId };
  await issueRefreshJti(redis, { jti: sentinels.jti, familyId: sentinels.familyId, ttlSeconds: 600 });
  const limits = RedisRequestLimits.fromAppConfig(redis, createTestConfig({
    RATE_LIMIT_WINDOW_MS: 600_000, MESSAGE_LIMIT_PER_USER_PER_WINDOW: 10,
    MESSAGE_LIMIT_PER_TENANT_PER_WINDOW: 10, TURN_QUOTA_PER_USER_PER_DAY: 10,
    TURN_QUOTA_PER_TENANT_PER_DAY: 10
  }));
  expect(await limits.consumeRateLimit({ resource: "message_turn", userId, tenantId })).toBeNull();
  expect(await limits.consumeTurnQuota({ userId, tenantId })).toBeNull();
  return sentinels;
}

async function expectSentinels(redis: Redis, s: Sentinels): Promise<void> {
  expect(await redis.get(`refresh_jti:${s.jti}`)).toBe(s.familyId);
  expect(await redis.get(`refresh_family:${s.familyId}`)).toBe("active");
  expect(await redis.get(`rl:message_turn:user:${s.userId}`)).toBe("1");
  expect(await redis.get(`rl:message_turn:tenant:${s.tenantId}`)).toBe("1");
  const day = new Date().toISOString().slice(0, 10);
  expect(await redis.get(`quota:user:${s.userId}:${day}`)).toBe("1");
  expect(await redis.get(`quota:tenant:${s.tenantId}:${day}`)).toBe("1");
}

async function tenantExists(tenantId: string): Promise<boolean> {
  return ((await superuserPool().query(`SELECT 1 FROM tenants WHERE tenant_id = $1`, [tenantId])).rowCount ?? 0) > 0;
}

function deleteFlags(tenantId: string, requestId: string, ...extra: string[]): string[] {
  return [
    "--tenant-id", tenantId, "--confirm", tenantId, "--request-id", requestId,
    "--third-party-disposition", "No third-party processor in the fixture.",
    "--backup-disposition", "The throwaway database is dropped after the suite.",
    "--maintenance-confirmed", ...extra
  ];
}

describe.skipIf(!adminDatabaseUrl() || !process.env.INTEGRATION_REDIS_URL)("tenant:delete command and Redis", () => {
  const clients: Redis[] = [];
  const written: { redis: Redis; pattern: string }[] = [];

  function connect(db: number): Redis {
    const redis = new Redis(redisUrl(db));
    clients.push(redis);
    return redis;
  }

  beforeAll(async () => {
    for (const db of [TARGET_DB, OTHER_DB]) {
      const redis = new Redis(redisUrl(db));
      try {
        const size = await redis.dbsize();
        if (size !== 0) {
          throw new Error(
            `Redis database ${db} of INTEGRATION_REDIS_URL holds ${size} keys. This suite flushes it: ` +
              "point INTEGRATION_REDIS_URL at a throwaway Redis, or empty databases 14 and 15 first."
          );
        }
      } finally {
        redis.disconnect();
      }
    }
  });

  afterEach(async () => {
    for (const { redis, pattern } of written.splice(0)) {
      const keys = await redis.keys(pattern);
      if (keys.length > 0) await redis.del(...keys);
    }
    for (const redis of clients.splice(0)) redis.disconnect();
  });

  async function scenario() {
    const target = connect(TARGET_DB);
    const other = connect(OTHER_DB);
    const deletedTenant = await seedTenant();
    const keptTenant = await seedTenant();
    const keptUser = await seedUser();
    await seedMembership(deletedTenant, await seedUser(), "owner");
    await seedMembership(keptTenant, keptUser, "owner");
    const sentinels = await seedSentinels(target, keptTenant, keptUser);
    const otherServiceKey = `other-service:${sentinels.id}`;
    await other.set(otherServiceKey, "kept");
    written.push(
      { redis: target, pattern: `*${sentinels.id}*` },
      { redis: target, pattern: `*${keptTenant}*` },
      { redis: target, pattern: `*${keptUser}*` },
      { redis: other, pattern: `*${sentinels.id}*` }
    );
    return { target, other, deletedTenant, keptTenant, sentinels, otherServiceKey, requestId: `NONPROD-${randomUUID()}` };
  }

  // The script file itself, as an operator starts it. REDIS_URL is set in the
  // child environment, so it wins over any apps/backend/.env file.
  test("the script deletes one tenant and leaves Redis alone without --flush-redis", async () => {
    const s = await scenario();
    const storageRoot = mkdtempSync(path.join(os.tmpdir(), "tenant-delete-"));

    const child = await execFileAsync(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "src/scripts/delete-tenant.ts", ...deleteFlags(s.deletedTenant, s.requestId)],
      {
        cwd: backendDir,
        env: {
          PATH: process.env.PATH,
          MIGRATION_DATABASE_URL: runSuperuserUrl(),
          REDIS_URL: redisUrl(TARGET_DB),
          ARTIFACT_STORAGE_BACKEND: "local",
          ARTIFACT_STORAGE_ROOT: path.join(storageRoot, "artifacts"),
          SKILL_BUNDLE_STORAGE_BACKEND: "local",
          SKILL_BUNDLE_STORAGE_ROOT: path.join(storageRoot, "skills")
        }
      }
    );

    await expectSentinels(s.target, s.sentinels);
    expect(await s.other.get(s.otherServiceKey)).toBe("kept");
    const receipt = JSON.parse(child.stdout) as Record<string, unknown>;
    expect(receipt).toMatchObject({ requestId: s.requestId, status: "completed", lastError: null });
    expect(receipt.redisDisposition).toBe(REDIS_DISPOSITION.notRequested);
    expect(await tenantExists(s.deletedTenant)).toBe(false);
    expect(await tenantExists(s.keptTenant)).toBe(true);
  }, 60_000);

  // The tests below call the command function in this process, with the real
  // database, storage and Redis factories. `env` is a plain object, so an
  // apps/backend/.env file cannot add a REDIS_URL to it.
  function command(argv: string[], options: { redisUrl?: string } = {}) {
    const storageRoot = mkdtempSync(path.join(os.tmpdir(), "tenant-delete-"));
    const env: NodeJS.ProcessEnv = {
      MIGRATION_DATABASE_URL: runSuperuserUrl(),
      ARTIFACT_STORAGE_BACKEND: "local",
      ARTIFACT_STORAGE_ROOT: path.join(storageRoot, "artifacts"),
      SKILL_BUNDLE_STORAGE_BACKEND: "local",
      SKILL_BUNDLE_STORAGE_ROOT: path.join(storageRoot, "skills"),
      ...(options.redisUrl ? { REDIS_URL: options.redisUrl } : {})
    };
    const connectRedis = vi.fn((url: string) => new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: true }));
    const printed: string[] = [];
    const warnings: string[] = [];
    const run = runDeleteTenant(argv, env, {
      connectRedis,
      print: (text) => printed.push(text),
      warn: (text) => warnings.push(text)
    });
    return {
      connectRedis,
      warnings,
      run: run.then((exitCode) => ({ exitCode, receipt: JSON.parse(printed.join("")) as Record<string, unknown> }))
    };
  }

  test("--flush-redis flushes only the database that REDIS_URL selects", async () => {
    const s = await scenario();

    const { connectRedis, warnings, run } = command(
      deleteFlags(s.deletedTenant, s.requestId, "--flush-redis"),
      { redisUrl: redisUrl(TARGET_DB) }
    );
    const { exitCode, receipt } = await run;

    expect(exitCode).toBe(0);
    expect(receipt).toMatchObject({ status: "completed", redisDisposition: REDIS_DISPOSITION.flushed, lastError: null });
    expect(connectRedis.mock.calls).toEqual([[redisUrl(TARGET_DB)]]);
    expect(warnings).toEqual([]);
    expect(await s.target.dbsize()).toBe(0);
    expect(await s.other.get(s.otherServiceKey)).toBe("kept");
    expect(await tenantExists(s.deletedTenant)).toBe(false);
  });

  test("--flush-redis without REDIS_URL is refused before anything is deleted", async () => {
    const s = await scenario();

    const { connectRedis, run } = command(deleteFlags(s.deletedTenant, s.requestId, "--flush-redis"));

    await expect(run).rejects.toThrow("--flush-redis needs REDIS_URL, but REDIS_URL is not configured. Nothing was deleted.");
    expect(connectRedis).not.toHaveBeenCalled();
    expect(await tenantExists(s.deletedTenant)).toBe(true);
    const receipts = await superuserPool().query(`SELECT 1 FROM tenant_deletion_receipts WHERE request_id = $1`, [s.requestId]);
    expect(receipts.rowCount).toBe(0);
    await expectSentinels(s.target, s.sentinels);
  });

  test.each([
    ["a repeated --flush-redis", ["--flush-redis", "--flush-redis"]],
    ["--flush-redis with a value", ["--flush-redis", "yes"]],
    ["--flush-redis=yes", ["--flush-redis=yes"]],
    ["an unknown flag", ["--flush-tenant-keys"]]
  ])("refuses %s and deletes nothing", async (_case, extra) => {
    const s = await scenario();

    const { connectRedis, run } = command(deleteFlags(s.deletedTenant, s.requestId, ...extra), {
      redisUrl: redisUrl(TARGET_DB)
    });

    await expect(run).rejects.toThrow(/^Usage: delete-tenant/);
    expect(connectRedis).not.toHaveBeenCalled();
    expect(await tenantExists(s.deletedTenant)).toBe(true);
    await expectSentinels(s.target, s.sentinels);
  });

  test("a replay with --flush-redis does not flush for a request that did not queue a flush", async () => {
    const s = await scenario();
    const first = command(deleteFlags(s.deletedTenant, s.requestId), { redisUrl: redisUrl(TARGET_DB) });
    const deleted = await first.run;
    expect(deleted).toMatchObject({ exitCode: 0, receipt: { status: "completed", redisDisposition: REDIS_DISPOSITION.notRequested } });
    expect(first.connectRedis).not.toHaveBeenCalled();

    const replay = command(deleteFlags(s.deletedTenant, s.requestId, "--flush-redis"), {
      redisUrl: redisUrl(TARGET_DB)
    });
    const replayed = await replay.run;

    // The completed receipt does not change and does not claim a flush.
    expect(replayed).toEqual(deleted);
    expect(replay.warnings).toEqual([expect.stringContaining("--flush-redis did nothing")]);
    await expectSentinels(s.target, s.sentinels);
    expect(await s.other.get(s.otherServiceKey)).toBe("kept");
  });

  // An older version queued a flush whenever REDIS_URL was set and wrote
  // "flushed" before it ran. When that flush failed, the flush stays queued.
  test("a flush that an older version queued runs only with --flush-redis, once", async () => {
    const s = await scenario();
    const legacy = new TenantDeletionService({
      db: superuserPool(),
      artifactStorage: { delete: async () => undefined },
      skillBundleStorage: { deleteBundle: async () => undefined },
      purgeRuntimeThread: async () => undefined,
      flushRedis: () => Promise.reject(new Error("Connection is closed."))
    });
    const legacyReceipt = await legacy.execute({
      requestId: s.requestId,
      tenantId: s.deletedTenant,
      redisDisposition: "Dedicated environment Redis database flushed; all sessions and rate-limit state invalidated.",
      thirdPartyDisposition: "None.",
      backupDisposition: "None."
    });
    expect(legacyReceipt.status).toBe("cleanup_failed");

    // Without the flag: no flush, the flush stays queued, and the receipt no
    // longer says "flushed".
    const withoutFlag = command(deleteFlags(s.deletedTenant, s.requestId), { redisUrl: redisUrl(TARGET_DB) });
    const refused = await withoutFlag.run;
    expect(refused.exitCode).toBe(1);
    expect(refused.receipt).toMatchObject({
      status: "cleanup_failed",
      completedAt: null,
      redisDisposition: REDIS_DISPOSITION.flushNotAllowed,
      lastError: expect.stringContaining("Run the command again with --flush-redis")
    });
    expect(withoutFlag.connectRedis).not.toHaveBeenCalled();
    await expectSentinels(s.target, s.sentinels);
    const queued = await superuserPool().query(
      `SELECT kind, attempts FROM tenant_deletion_cleanup WHERE request_id = $1`,
      [s.requestId]
    );
    expect(queued.rows).toEqual([{ kind: "redis_database", attempts: 2 }]);

    // With the flag: the queued flush runs and the receipt completes.
    const withFlag = command(deleteFlags(s.deletedTenant, s.requestId, "--flush-redis"), {
      redisUrl: redisUrl(TARGET_DB)
    });
    const flushed = await withFlag.run;
    expect(flushed.exitCode).toBe(0);
    expect(flushed.receipt).toMatchObject({ status: "completed", redisDisposition: REDIS_DISPOSITION.flushed, lastError: null });
    expect(withFlag.warnings).toEqual([]);
    expect(await s.target.dbsize()).toBe(0);
    expect(await s.other.get(s.otherServiceKey)).toBe("kept");

    // The same command again: the receipt is complete, so nothing is flushed.
    const again = await seedSentinels(s.target, s.keptTenant, `${s.sentinels.userId}-again`);
    written.push({ redis: s.target, pattern: `*${again.id}*` }, { redis: s.target, pattern: `*${again.userId}*` });
    const repeat = command(deleteFlags(s.deletedTenant, s.requestId, "--flush-redis"), {
      redisUrl: redisUrl(TARGET_DB)
    });
    expect(await repeat.run).toEqual(flushed);
    expect(repeat.warnings).toEqual([expect.stringContaining("--flush-redis did nothing")]);
    await expectSentinels(s.target, again);
  });
});
