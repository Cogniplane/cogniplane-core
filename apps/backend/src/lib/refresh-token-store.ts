// Refresh token rotation with replay-detection.
//
// Each refresh token belongs to a "family" identified by `fid`. Login mints a
// fresh family; every rotation issues a new jti tied to the same family.
//
// On rotation, the old jti is consumed atomically and a short-lived rotation
// marker is created. Concurrent requests can reuse the winner's completed
// result instead of being misclassified as token theft. Once that grace marker
// expires, presenting the consumed jti is a replay and revokes the family.
//
// Redis layout:
//   refresh_jti:<jti>      → familyId  (TTL = refresh max-age)
//   refresh_family:<fid>   → "active" | "revoked"  (TTL = refresh max-age)
//   refresh_family_login_at:<fid> → initial login epoch seconds (30d, never extended)
//   refresh_rotation:<jti> → pending marker or completed token result (60s)

const FAMILY_ACTIVE = "active";
const FAMILY_REVOKED = "revoked";

function jtiKey(jti: string): string {
  return `refresh_jti:${jti}`;
}

function familyKey(familyId: string): string {
  return `refresh_family:${familyId}`;
}

function familyLoginAtKey(familyId: string): string {
  return `refresh_family_login_at:${familyId}`;
}

function rotationKey(jti: string): string {
  return `refresh_rotation:${jti}`;
}

export const REFRESH_ROTATION_GRACE_SECONDS = 60;
export const REFRESH_FAMILY_ABSOLUTE_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
const ROTATION_PENDING_PREFIX = "pending:";
const ROTATION_COMPLETE_PREFIX = "complete:";

const ISSUE_REFRESH_JTI = `
  -- refresh-token-issue-v1
  local familyState = redis.call('GET', KEYS[2])
  if familyState == ARGV[2] then
    return 0
  end
  if not redis.call('GET', KEYS[3]) then
    redis.call('SET', KEYS[3], ARGV[3], 'EX', ARGV[4])
  end
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[5])
  redis.call('SET', KEYS[2], ARGV[6], 'EX', ARGV[5])
  return 1
`;

const CLAIM_REFRESH_ROTATION = `
  -- refresh-token-rotation-claim-v1
  local familyState = redis.call('GET', KEYS[2])
  if familyState == ARGV[2] then
    return {2}
  end

  local loginAt = redis.call('GET', KEYS[4])
  if familyState == ARGV[5] then
    local loginAtNumber = tonumber(loginAt)
    local now = tonumber(ARGV[6])
    local absoluteLifetime = tonumber(ARGV[7])
    if not loginAtNumber or now - loginAtNumber >= absoluteLifetime then
      redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[8])
      return {5}
    end
  end

  local consumed = redis.call('GET', KEYS[1])
  if consumed then
    redis.call('DEL', KEYS[1])
    if consumed ~= ARGV[1] then
      return {1, consumed}
    end
    redis.call('SET', KEYS[3], ARGV[3] .. consumed, 'EX', ARGV[4])
    return {0, consumed}
  end

  local rotation = redis.call('GET', KEYS[3])
  if rotation then
    return {3, rotation}
  end
  if familyState == ARGV[5] then
    return {1, ARGV[1]}
  end
  return {4}
`;

// Undo a claim whose rotation never completed.
//
// The claim is not the end of /auth/refresh: the handler still reads the
// membership and mints tokens. If any of that throws, the jti is already
// consumed — the client's next attempt then either waits out the grace marker
// (503) or, once it expires, looks like a replay and revokes the whole family.
// Restoring puts the caller back exactly where it started.
//
// Three guards make this safe to call on any failure path:
//   1. Only a `pending:` marker is cleared. A `complete:` marker means the
//      rotation actually finished, so its cached result must survive.
//   2. The family must still be active — never resurrect a jti into a revoked
//      family.
//   3. The restored TTL is copied from the family key rather than passed in.
//      Issue sets both keys with the same expiry at the same instant and the
//      claim never rewrites the family TTL, so this is the original remaining
//      lifetime. A caller-supplied TTL would silently extend the token.
const RESTORE_REFRESH_JTI = `
  -- refresh-token-restore-v1
  local marker = redis.call('GET', KEYS[3])
  if marker and string.sub(marker, 1, string.len(ARGV[2])) ~= ARGV[2] then
    return 0
  end
  if redis.call('GET', KEYS[2]) ~= ARGV[3] then
    return 0
  end
  local ttl = redis.call('PTTL', KEYS[2])
  if not ttl or ttl <= 0 then
    return 0
  end
  redis.call('DEL', KEYS[3])
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ttl)
  return 1
`;

// Subset of ioredis we need. Defined locally so tests can stub with a Map.
export type RefreshTokenRedis = {
  get(key: string): Promise<string | null>;
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
};

export type RefreshRotationResult = {
  accessToken: string;
  refreshToken: string;
};

export type ConsumeResult =
  | { status: "ok"; familyId: string }
  | { status: "concurrent"; result: RefreshRotationResult | null }
  | { status: "reuse_detected"; familyId: string }
  | { status: "absolute_expired" }
  | { status: "revoked" }
  | { status: "not_found" };

function parseCompletedRotation(value: string): RefreshRotationResult | null {
  if (!value.startsWith(ROTATION_COMPLETE_PREFIX)) return null;
  try {
    const parsed = JSON.parse(value.slice(ROTATION_COMPLETE_PREFIX.length)) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "accessToken" in parsed &&
      typeof parsed.accessToken === "string" &&
      "refreshToken" in parsed &&
      typeof parsed.refreshToken === "string"
    ) {
      return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken };
    }
  } catch {
    // Treat malformed cache data as an unavailable in-flight result.
  }
  return null;
}

export async function issueRefreshJti(
  redis: RefreshTokenRedis,
  input: {
    jti: string;
    familyId: string;
    ttlSeconds: number;
    loginAtEpochSeconds?: number;
    absoluteLifetimeSeconds?: number;
  }
): Promise<void> {
  const issued = (await redis.eval(
    ISSUE_REFRESH_JTI,
    3,
    jtiKey(input.jti),
    familyKey(input.familyId),
    familyLoginAtKey(input.familyId),
    input.familyId,
    FAMILY_REVOKED,
    String(input.loginAtEpochSeconds ?? Math.floor(Date.now() / 1_000)),
    String(input.absoluteLifetimeSeconds ?? REFRESH_FAMILY_ABSOLUTE_LIFETIME_SECONDS),
    String(input.ttlSeconds),
    FAMILY_ACTIVE
  )) as number;
  if (issued !== 1) {
    throw new Error("Cannot issue a refresh jti for a revoked family");
  }
}

export async function consumeRefreshJti(
  redis: RefreshTokenRedis,
  input: {
    jti: string;
    familyId: string;
    graceSeconds?: number;
    nowEpochSeconds?: number;
    absoluteLifetimeSeconds?: number;
    familyTtlSeconds?: number;
  }
): Promise<ConsumeResult> {
  const raw = (await redis.eval(
    CLAIM_REFRESH_ROTATION,
    4,
    jtiKey(input.jti),
    familyKey(input.familyId),
    rotationKey(input.jti),
    familyLoginAtKey(input.familyId),
    input.familyId,
    FAMILY_REVOKED,
    ROTATION_PENDING_PREFIX,
    String(input.graceSeconds ?? REFRESH_ROTATION_GRACE_SECONDS),
    FAMILY_ACTIVE,
    String(input.nowEpochSeconds ?? Math.floor(Date.now() / 1_000)),
    String(input.absoluteLifetimeSeconds ?? REFRESH_FAMILY_ABSOLUTE_LIFETIME_SECONDS),
    String(input.familyTtlSeconds ?? REFRESH_FAMILY_ABSOLUTE_LIFETIME_SECONDS)
  )) as [number, string?];

  const [status, value] = raw;
  if (status === 0 && value) return { status: "ok", familyId: value };
  if (status === 1 && value) return { status: "reuse_detected", familyId: value };
  if (status === 2) return { status: "revoked" };
  if (status === 3 && value) {
    return { status: "concurrent", result: parseCompletedRotation(value) };
  }
  if (status === 5) return { status: "absolute_expired" };
  return { status: "not_found" };
}

/**
 * Reverses a claim whose rotation never completed. Returns true when the jti
 * was restored, false when the restore was declined (rotation already
 * completed, family revoked or expired) — a false is not an error.
 */
export async function restoreRefreshJti(
  redis: RefreshTokenRedis,
  input: { jti: string; familyId: string }
): Promise<boolean> {
  const restored = (await redis.eval(
    RESTORE_REFRESH_JTI,
    3,
    jtiKey(input.jti),
    familyKey(input.familyId),
    rotationKey(input.jti),
    input.familyId,
    ROTATION_PENDING_PREFIX,
    FAMILY_ACTIVE
  )) as number;

  return restored === 1;
}

export async function completeRefreshRotation(
  redis: RefreshTokenRedis,
  input: { jti: string; result: RefreshRotationResult; graceSeconds?: number }
): Promise<void> {
  await redis.set(
    rotationKey(input.jti),
    `${ROTATION_COMPLETE_PREFIX}${JSON.stringify(input.result)}`,
    "EX",
    input.graceSeconds ?? REFRESH_ROTATION_GRACE_SECONDS
  );
}

export async function waitForRefreshRotation(
  redis: RefreshTokenRedis,
  input: { jti: string; timeoutMs?: number; pollIntervalMs?: number }
): Promise<RefreshRotationResult | null> {
  const timeoutMs = input.timeoutMs ?? 2_000;
  const pollIntervalMs = input.pollIntervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const value = await redis.get(rotationKey(input.jti));
    if (value === null) return null;
    const result = parseCompletedRotation(value);
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return null;
}

export async function revokeRefreshFamily(
  redis: RefreshTokenRedis,
  input: { familyId: string; ttlSeconds: number }
): Promise<void> {
  await redis.set(familyKey(input.familyId), FAMILY_REVOKED, "EX", input.ttlSeconds);
}
