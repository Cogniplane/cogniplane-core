import { test, expect } from "vitest";

import { FakeRefreshTokenRedis } from "../test-helpers/fake-refresh-token-redis.js";
import {
  completeRefreshRotation,
  consumeRefreshJti,
  REFRESH_FAMILY_ABSOLUTE_LIFETIME_SECONDS,
  issueRefreshJti,
  restoreRefreshJti,
  revokeRefreshFamily,
  waitForRefreshRotation
} from "./refresh-token-store.js";

function makeFakeRedis(): FakeRefreshTokenRedis {
  return new FakeRefreshTokenRedis();
}

const TTL = 60;

test("issueRefreshJti binds the jti to the family and marks family active", async () => {
  const redis = makeFakeRedis();
  await issueRefreshJti(redis, { jti: "j1", familyId: "f1", ttlSeconds: TTL });
  expect(redis.store.get("refresh_jti:j1")).toBe("f1");
  expect(redis.store.get("refresh_family:f1")).toBe("active");
});

test("issueRefreshJti writes both keys with a bounded EX TTL", async () => {
  const redis = makeFakeRedis();
  await issueRefreshJti(redis, { jti: "j1", familyId: "f1", ttlSeconds: TTL });

  // TTL is only observable via the captured set() tuple — the value Map
  // doesn't model expiry. Pin EX/ttl so neither key is written unbounded.
  expect(redis.setCalls).toContainEqual({
    key: "refresh_jti:j1",
    value: "f1",
    mode: "EX",
    ttlSeconds: TTL
  });
  expect(redis.setCalls).toContainEqual({
    key: "refresh_family:f1",
    value: "active",
    mode: "EX",
    ttlSeconds: TTL
  });
});

test("issueRefreshJti stores the family login time once and never extends it", async () => {
  const redis = makeFakeRedis();
  await issueRefreshJti(redis, {
    jti: "j1",
    familyId: "f1",
    ttlSeconds: TTL,
    loginAtEpochSeconds: 100
  });
  await issueRefreshJti(redis, {
    jti: "j2",
    familyId: "f1",
    ttlSeconds: TTL,
    loginAtEpochSeconds: 200
  });

  expect(redis.store.get("refresh_family_login_at:f1")).toBe("100");
  expect(
    redis.setCalls.filter((call) => call.key === "refresh_family_login_at:f1")
  ).toHaveLength(1);
});

test("issueRefreshJti refuses to resurrect a revoked family", async () => {
  const redis = makeFakeRedis();
  await issueRefreshJti(redis, { jti: "j1", familyId: "f1", ttlSeconds: TTL });
  await revokeRefreshFamily(redis, { familyId: "f1", ttlSeconds: TTL });

  await expect(
    issueRefreshJti(redis, { jti: "j2", familyId: "f1", ttlSeconds: TTL })
  ).rejects.toThrow("revoked family");
  expect(redis.store.has("refresh_jti:j2")).toBe(false);
});

test("consumeRefreshJti returns ok on the first use and removes the jti", async () => {
  const redis = makeFakeRedis();
  await issueRefreshJti(redis, { jti: "j1", familyId: "f1", ttlSeconds: TTL });
  const result = await consumeRefreshJti(redis, { jti: "j1", familyId: "f1" });
  expect(result).toEqual({ status: "ok", familyId: "f1" });
  expect(redis.store.has("refresh_jti:j1")).toBe(false);
});

test("consumeRefreshJti treats a second request inside the grace window as concurrent", async () => {
  const redis = makeFakeRedis();
  await issueRefreshJti(redis, { jti: "j1", familyId: "f1", ttlSeconds: TTL });

  // Legitimate first use rotates the token.
  const first = await consumeRefreshJti(redis, { jti: "j1", familyId: "f1" });
  expect(first.status).toBe("ok");

  const concurrent = await consumeRefreshJti(redis, { jti: "j1", familyId: "f1" });
  expect(concurrent).toEqual({ status: "concurrent", result: null });
});

test("completed rotations are returned idempotently during the grace window", async () => {
  const redis = makeFakeRedis();
  await issueRefreshJti(redis, { jti: "j1", familyId: "f1", ttlSeconds: TTL });
  await consumeRefreshJti(redis, { jti: "j1", familyId: "f1" });
  const result = { accessToken: "access", refreshToken: "refresh" };
  await completeRefreshRotation(redis, { jti: "j1", result });

  expect(await consumeRefreshJti(redis, { jti: "j1", familyId: "f1" })).toEqual({
    status: "concurrent",
    result
  });
  expect(await waitForRefreshRotation(redis, { jti: "j1", timeoutMs: 0 })).toEqual(result);
});

test("consumeRefreshJti detects reuse after the rotation grace record expires", async () => {
  const redis = makeFakeRedis();
  await issueRefreshJti(redis, { jti: "j1", familyId: "f1", ttlSeconds: TTL });
  await consumeRefreshJti(redis, { jti: "j1", familyId: "f1" });
  redis.store.delete("refresh_rotation:j1");

  expect(await consumeRefreshJti(redis, { jti: "j1", familyId: "f1" })).toEqual({
    status: "reuse_detected",
    familyId: "f1"
  });
});

test("consumeRefreshJti revokes a family at the absolute session lifetime", async () => {
  const redis = makeFakeRedis();
  const loginAt = 1_000;
  await issueRefreshJti(redis, {
    jti: "j1",
    familyId: "f1",
    ttlSeconds: TTL,
    loginAtEpochSeconds: loginAt
  });

  const result = await consumeRefreshJti(redis, {
    jti: "j1",
    familyId: "f1",
    nowEpochSeconds: loginAt + REFRESH_FAMILY_ABSOLUTE_LIFETIME_SECONDS,
    familyTtlSeconds: TTL
  });

  expect(result).toEqual({ status: "absolute_expired" });
  expect(redis.store.get("refresh_family:f1")).toBe("revoked");
  expect(redis.store.has("refresh_jti:j1")).toBe(true);
});

test("consumeRefreshJti allows the final second before the absolute lifetime", async () => {
  const redis = makeFakeRedis();
  const loginAt = 1_000;
  await issueRefreshJti(redis, {
    jti: "j1",
    familyId: "f1",
    ttlSeconds: TTL,
    loginAtEpochSeconds: loginAt
  });

  const result = await consumeRefreshJti(redis, {
    jti: "j1",
    familyId: "f1",
    nowEpochSeconds: loginAt + REFRESH_FAMILY_ABSOLUTE_LIFETIME_SECONDS - 1
  });
  expect(result).toEqual({ status: "ok", familyId: "f1" });
});

test("consumeRefreshJti returns revoked when the family was already revoked", async () => {
  const redis = makeFakeRedis();
  await issueRefreshJti(redis, { jti: "j1", familyId: "f1", ttlSeconds: TTL });
  await revokeRefreshFamily(redis, { familyId: "f1", ttlSeconds: TTL });

  const result = await consumeRefreshJti(redis, { jti: "j1", familyId: "f1" });
  expect(result).toEqual({ status: "revoked" });
});

test("consumeRefreshJti returns not_found when neither the jti nor the family exists", async () => {
  const redis = makeFakeRedis();
  const result = await consumeRefreshJti(redis, {
    jti: "unknown",
    familyId: "unknown"
  });
  expect(result).toEqual({ status: "not_found" });
});

test("consumeRefreshJti flags reuse when the jti belongs to a different family", async () => {
  const redis = makeFakeRedis();
  // Issue under family f1, but the JWT presented claims family f2.
  await issueRefreshJti(redis, { jti: "j1", familyId: "f1", ttlSeconds: TTL });
  // Make f2 active too so we hit the family-mismatch branch (not "not_found").
  await issueRefreshJti(redis, { jti: "j99", familyId: "f2", ttlSeconds: TTL });

  const result = await consumeRefreshJti(redis, { jti: "j1", familyId: "f2" });
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
  const result = await consumeRefreshJti(redis, { jti: "j2", familyId: "f1" });
  expect(result).toEqual({ status: "revoked" });
});

test("revokeRefreshFamily writes the revoked marker with a bounded EX TTL", async () => {
  const redis = makeFakeRedis();
  await revokeRefreshFamily(redis, { familyId: "f1", ttlSeconds: TTL });

  // An unbounded revoked-family key is a security smell (it would never
  // expire). TTL is only observable through the captured set() tuple.
  expect(redis.setCalls).toContainEqual({
    key: "refresh_family:f1",
    value: "revoked",
    mode: "EX",
    ttlSeconds: TTL
  });
});

test("rotation chain: issue → consume → issue (same family) → consume succeeds", async () => {
  const redis = makeFakeRedis();
  await issueRefreshJti(redis, { jti: "j1", familyId: "f1", ttlSeconds: TTL });

  // First refresh: consume j1, issue j2 (same family).
  const first = await consumeRefreshJti(redis, { jti: "j1", familyId: "f1" });
  expect(first.status).toBe("ok");
  await issueRefreshJti(redis, { jti: "j2", familyId: "f1", ttlSeconds: TTL });

  // Second refresh on j2 succeeds.
  const second = await consumeRefreshJti(redis, { jti: "j2", familyId: "f1" });
  expect(second.status).toBe("ok");

  // Replaying j1 now is reuse — family was active when the chain was
  // continuing, so reuse_detected.
  redis.store.delete("refresh_rotation:j1");
  const replay = await consumeRefreshJti(redis, { jti: "j1", familyId: "f1" });
  expect(replay.status).toBe("reuse_detected");
});

// restoreRefreshJti — the recovery path for a rotation that claimed the jti and
// then failed. Without it, the caller's retry either waits out the grace marker
// or, once that expires, looks like a replay and revokes the whole family.
//
// NOTE: the fake is a hand-written mirror of the Lua, so these tests pin the
// mirror's behaviour, not Redis's. Breaking the real script without breaking
// the mirror would not fail here — change both together.

test("restoreRefreshJti puts a claimed jti back so the next attempt succeeds", async () => {
  const redis = makeFakeRedis();
  await issueRefreshJti(redis, { jti: "j1", familyId: "f1", ttlSeconds: TTL });

  const claim = await consumeRefreshJti(redis, { jti: "j1", familyId: "f1" });
  expect(claim.status).toBe("ok");
  // The claim consumed the jti and left a pending marker.
  expect(redis.store.get("refresh_jti:j1")).toBeUndefined();
  expect(redis.store.get("refresh_rotation:j1")).toMatch(/^pending:/);

  expect(await restoreRefreshJti(redis, { jti: "j1", familyId: "f1" })).toBe(true);

  // Back to the pre-claim state: the jti is live and the marker is gone, so a
  // retry is an ordinary rotation rather than a replay.
  expect(redis.store.get("refresh_jti:j1")).toBe("f1");
  expect(redis.store.get("refresh_rotation:j1")).toBeUndefined();
  expect((await consumeRefreshJti(redis, { jti: "j1", familyId: "f1" })).status).toBe("ok");
});

test("restoreRefreshJti carries over the family's remaining lifetime, never a fresh one", async () => {
  const redis = makeFakeRedis();
  await issueRefreshJti(redis, { jti: "j1", familyId: "f1", ttlSeconds: TTL });

  // Simulate time passing: the family key is most of the way through its TTL.
  redis.ttlMs.set("refresh_family:f1", 5_000);

  await consumeRefreshJti(redis, { jti: "j1", familyId: "f1" });
  await restoreRefreshJti(redis, { jti: "j1", familyId: "f1" });

  // The restored token expires when the original would have. Reusing the
  // configured TTL here would hand the caller a brand-new lifetime on every
  // failed rotation — an indefinite extension for anyone who can make the
  // rotation fail.
  expect(redis.ttlMs.get("refresh_jti:j1")).toBe(5_000);
});

test("restoreRefreshJti declines once the rotation has completed", async () => {
  const redis = makeFakeRedis();
  await issueRefreshJti(redis, { jti: "j1", familyId: "f1", ttlSeconds: TTL });
  await consumeRefreshJti(redis, { jti: "j1", familyId: "f1" });
  await completeRefreshRotation(redis, {
    jti: "j1",
    result: { accessToken: "at", refreshToken: "rt" }
  });

  // The rotation did succeed; restoring would revive a spent token and destroy
  // the cached result that concurrent callers are waiting on.
  expect(await restoreRefreshJti(redis, { jti: "j1", familyId: "f1" })).toBe(false);
  expect(redis.store.get("refresh_jti:j1")).toBeUndefined();
  expect(redis.store.get("refresh_rotation:j1")).toMatch(/^complete:/);
});

test("restoreRefreshJti declines when the family has been revoked", async () => {
  const redis = makeFakeRedis();
  await issueRefreshJti(redis, { jti: "j1", familyId: "f1", ttlSeconds: TTL });
  await consumeRefreshJti(redis, { jti: "j1", familyId: "f1" });
  await revokeRefreshFamily(redis, { familyId: "f1", ttlSeconds: TTL });

  // Revocation is the theft response; a restore must never undo it.
  expect(await restoreRefreshJti(redis, { jti: "j1", familyId: "f1" })).toBe(false);
  expect(redis.store.get("refresh_jti:j1")).toBeUndefined();
});
