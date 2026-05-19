import { test, expect } from "vitest";

import {
  consumeRefreshJti,
  issueRefreshJti,
  revokeRefreshFamily,
  type RefreshTokenRedis
} from "./refresh-token-store.js";

function makeFakeRedis(): RefreshTokenRedis & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    async getdel(key: string) {
      const value = store.get(key) ?? null;
      store.delete(key);
      return value;
    },
    async set(key: string, value: string) {
      store.set(key, value);
      return "OK";
    }
  };
}

const TTL = 60;

test("issueRefreshJti binds the jti to the family and marks family active", async () => {
  const redis = makeFakeRedis();
  await issueRefreshJti(redis, { jti: "j1", familyId: "f1", ttlSeconds: TTL });
  expect(redis.store.get("refresh_jti:j1")).toBe("f1");
  expect(redis.store.get("refresh_family:f1")).toBe("active");
});

test("consumeRefreshJti returns ok on the first use and removes the jti", async () => {
  const redis = makeFakeRedis();
  await issueRefreshJti(redis, { jti: "j1", familyId: "f1", ttlSeconds: TTL });
  const result = await consumeRefreshJti(redis, { jti: "j1", familyId: "f1", ttlSeconds: TTL });
  expect(result).toEqual({ status: "ok", familyId: "f1" });
  expect(redis.store.has("refresh_jti:j1")).toBe(false);
});

test("consumeRefreshJti detects reuse when the jti is replayed after rotation", async () => {
  const redis = makeFakeRedis();
  await issueRefreshJti(redis, { jti: "j1", familyId: "f1", ttlSeconds: TTL });

  // Legitimate first use rotates the token.
  const first = await consumeRefreshJti(redis, { jti: "j1", familyId: "f1", ttlSeconds: TTL });
  expect(first.status).toBe("ok");

  // Attacker replays the same jti — family is still active → reuse_detected.
  const replay = await consumeRefreshJti(redis, { jti: "j1", familyId: "f1", ttlSeconds: TTL });
  expect(replay).toEqual({ status: "reuse_detected", familyId: "f1" });
});

test("consumeRefreshJti returns revoked when the family was already revoked", async () => {
  const redis = makeFakeRedis();
  await issueRefreshJti(redis, { jti: "j1", familyId: "f1", ttlSeconds: TTL });
  await revokeRefreshFamily(redis, { familyId: "f1", ttlSeconds: TTL });

  const result = await consumeRefreshJti(redis, { jti: "j1", familyId: "f1", ttlSeconds: TTL });
  expect(result).toEqual({ status: "revoked" });
});

test("consumeRefreshJti returns not_found when neither the jti nor the family exists", async () => {
  const redis = makeFakeRedis();
  const result = await consumeRefreshJti(redis, {
    jti: "unknown",
    familyId: "unknown",
    ttlSeconds: TTL
  });
  expect(result).toEqual({ status: "not_found" });
});

test("consumeRefreshJti flags reuse when the jti belongs to a different family", async () => {
  const redis = makeFakeRedis();
  // Issue under family f1, but the JWT presented claims family f2.
  await issueRefreshJti(redis, { jti: "j1", familyId: "f1", ttlSeconds: TTL });
  // Make f2 active too so we hit the family-mismatch branch (not "not_found").
  await issueRefreshJti(redis, { jti: "j99", familyId: "f2", ttlSeconds: TTL });

  const result = await consumeRefreshJti(redis, { jti: "j1", familyId: "f2", ttlSeconds: TTL });
  // The replay should expose the *real* family of the jti so the route can
  // revoke whichever chain actually owns it.
  expect(result).toEqual({ status: "reuse_detected", familyId: "f1" });
});

test("revokeRefreshFamily marks the family revoked so subsequent consumes fail", async () => {
  const redis = makeFakeRedis();
  await issueRefreshJti(redis, { jti: "j1", familyId: "f1", ttlSeconds: TTL });
  await issueRefreshJti(redis, { jti: "j2", familyId: "f1", ttlSeconds: TTL });

  await revokeRefreshFamily(redis, { familyId: "f1", ttlSeconds: TTL });

  // Even though j2's record still exists, consuming it returns "revoked"
  // because the family-state check runs first.
  const result = await consumeRefreshJti(redis, { jti: "j2", familyId: "f1", ttlSeconds: TTL });
  expect(result).toEqual({ status: "revoked" });
});

test("rotation chain: issue → consume → issue (same family) → consume succeeds", async () => {
  const redis = makeFakeRedis();
  await issueRefreshJti(redis, { jti: "j1", familyId: "f1", ttlSeconds: TTL });

  // First refresh: consume j1, issue j2 (same family).
  const first = await consumeRefreshJti(redis, { jti: "j1", familyId: "f1", ttlSeconds: TTL });
  expect(first.status).toBe("ok");
  await issueRefreshJti(redis, { jti: "j2", familyId: "f1", ttlSeconds: TTL });

  // Second refresh on j2 succeeds.
  const second = await consumeRefreshJti(redis, { jti: "j2", familyId: "f1", ttlSeconds: TTL });
  expect(second.status).toBe("ok");

  // Replaying j1 now is reuse — family was active when the chain was
  // continuing, so reuse_detected.
  const replay = await consumeRefreshJti(redis, { jti: "j1", familyId: "f1", ttlSeconds: TTL });
  expect(replay.status).toBe("reuse_detected");
});
