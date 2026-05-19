// Refresh token rotation with replay-detection.
//
// Each refresh token belongs to a "family" identified by `fid`. Login mints a
// fresh family; every rotation issues a new jti tied to the same family.
//
// On rotation, the old jti is consumed atomically (`GETDEL`) and a new one is
// issued. If a refresh attempt presents a jti that was already consumed but
// the family is still active, that's a replay — the entire family is revoked
// so the legitimate user is forced to re-authenticate. This mirrors the
// reuse-detection model recommended by RFC 6749 §10.4 / OAuth 2.1.
//
// Redis layout:
//   refresh_jti:<jti>      → familyId  (TTL = refresh max-age)
//   refresh_family:<fid>   → "active" | "revoked"  (TTL = refresh max-age)

const FAMILY_ACTIVE = "active";
const FAMILY_REVOKED = "revoked";

function jtiKey(jti: string): string {
  return `refresh_jti:${jti}`;
}

function familyKey(familyId: string): string {
  return `refresh_family:${familyId}`;
}

// Subset of ioredis we need. Defined locally so tests can stub with a Map.
export type RefreshTokenRedis = {
  get(key: string): Promise<string | null>;
  getdel(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
};

export type ConsumeResult =
  | { status: "ok"; familyId: string }
  | { status: "reuse_detected"; familyId: string }
  | { status: "revoked" }
  | { status: "not_found" };

export async function issueRefreshJti(
  redis: RefreshTokenRedis,
  input: { jti: string; familyId: string; ttlSeconds: number }
): Promise<void> {
  await redis.set(jtiKey(input.jti), input.familyId, "EX", input.ttlSeconds);
  // SET (not SETNX) — overwrites the family TTL so it tracks the latest
  // rotation. Status remains "active" until explicit revocation.
  await redis.set(familyKey(input.familyId), FAMILY_ACTIVE, "EX", input.ttlSeconds);
}

export async function consumeRefreshJti(
  redis: RefreshTokenRedis,
  input: { jti: string; familyId: string; ttlSeconds: number }
): Promise<ConsumeResult> {
  const familyState = await redis.get(familyKey(input.familyId));
  if (familyState === FAMILY_REVOKED) {
    // Family was already revoked — the caller must reject the refresh but
    // does not need to take further action.
    return { status: "revoked" };
  }

  const consumed = await redis.getdel(jtiKey(input.jti));
  if (consumed === null) {
    // Jti is gone. If the family is still active, this is a replay of a
    // rotated token. Caller should revoke the family.
    if (familyState === FAMILY_ACTIVE) {
      return { status: "reuse_detected", familyId: input.familyId };
    }
    return { status: "not_found" };
  }

  if (consumed !== input.familyId) {
    // The jti exists but is bound to a different family than the JWT claims.
    // Treat as a tampering / replay attempt against whichever family the jti
    // actually belonged to.
    return { status: "reuse_detected", familyId: consumed };
  }

  return { status: "ok", familyId: consumed };
}

export async function revokeRefreshFamily(
  redis: RefreshTokenRedis,
  input: { familyId: string; ttlSeconds: number }
): Promise<void> {
  await redis.set(familyKey(input.familyId), FAMILY_REVOKED, "EX", input.ttlSeconds);
}
