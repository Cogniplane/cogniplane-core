import { beforeEach, describe, expect, test } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";

import { registerSessionRoutes } from "./auth-session.js";
import { signRefreshToken } from "../lib/jwt.js";
import { issueRefreshJti } from "../lib/refresh-token-store.js";
import { RefreshTokenRotationService } from "../services/auth/refresh-token-rotation-service.js";
import { createTestConfig } from "../test-helpers/test-config.js";
import { FakePool } from "../test-helpers/fake-pool.js";
import { FakeRefreshTokenRedis } from "../test-helpers/fake-refresh-token-redis.js";
import { InMemoryAuditEventStore } from "../test-helpers/in-memory-audit-events.js";

// /auth/refresh for a local account, whose session is valid only while its
// security version is the account's current one (lib/auth-admission.ts).
// routes/auth.test.ts covers the other refusals with a WorkOS tenant.

const CONFIG = createTestConfig({ AUTH_MODE: "jwt", AUTH_LOGIN_TYPES: ["local"] });

type Harness = { app: FastifyInstance; pool: FakePool; redis: FakeRefreshTokenRedis; account: { securityVersion: number } };

async function buildHarness(): Promise<Harness> {
  const pool = new FakePool();
  const redis = new FakeRefreshTokenRedis();
  const account = { securityVersion: 1 };
  pool.onQuery(/SELECT tm\.role, t\.login_type, u\.auth_source/, () => ({
    rows: [{ role: "member", login_type: "local", auth_source: "local", local_status: "active", security_version: account.securityVersion }],
    rowCount: 1
  }));
  pool.onQuery(/SELECT email FROM users/, () => ({ rows: [{ email: "person@example.test" }], rowCount: 1 }));

  const app = Fastify();
  await app.register(cookie);
  await registerSessionRoutes(app, {
    db: pool.asPool(),
    config: CONFIG,
    auditEvents: new InMemoryAuditEventStore() as never,
    refreshTokens: new RefreshTokenRotationService(redis, 60)
  });
  return { app, pool, redis, account };
}

/** A refresh cookie of a local session that started at `securityVersion`. */
async function localSessionCookie(harness: Harness, familyId: string, securityVersion: number): Promise<string> {
  const jti = `jti-${familyId}`;
  await issueRefreshJti(harness.redis, { jti, familyId, ttlSeconds: 60 });
  return signRefreshToken(CONFIG, { sub: "user-1", tid: "tenant-1", jti, fid: familyId, sv: securityVersion, amr: ["pwd"] });
}

function refresh(harness: Harness, refreshToken: string) {
  return harness.app.inject({
    method: "POST",
    url: "/auth/refresh",
    headers: { origin: CONFIG.API_ORIGIN },
    cookies: { cogniplane_refresh: refreshToken }
  });
}

/** The refresh cookie of an answer: its value, or "" when the answer deletes it. */
function refreshSetCookie(header: string | string[] | undefined): string | null {
  const headers = Array.isArray(header) ? header : header ? [header] : [];
  const line = headers.find((value) => value.startsWith("cogniplane_refresh="));
  return line === undefined ? null : line.slice("cogniplane_refresh=".length).split(";")[0];
}

describe("POST /auth/refresh, a local session of an older security version", () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await buildHarness();
  });

  test("rotates the cookie of the current security version", async () => {
    const res = await refresh(harness, await localSessionCookie(harness, "fid-current", 1));

    expect(res.statusCode).toBe(200);
    expect(refreshSetCookie(res.headers["set-cookie"])).toMatch(/.+/);
  });

  // The membership read is one statement on the privileged pool, with no
  // BEGIN, set_config or COMMIT. The email read follows it.
  test("reads the membership with one statement, outside a transaction", async () => {
    const res = await refresh(harness, await localSessionCookie(harness, "fid-statements", 1));

    expect(res.statusCode).toBe(200);
    expect(harness.pool.queries.map(({ text, values }) => [text.trim().split("\n")[0], values])).toEqual([
      ["SELECT tm.role, t.login_type, u.auth_source, li.status AS local_status, li.security_version,", ["tenant-1", "user-1"]],
      ["SELECT email FROM users WHERE user_id = $1 LIMIT 1", ["user-1"]]
    ]);
  });

  // Another tab can have the newer cookie when this answer arrives: for
  // example, the enrolment that increased the security version. A deletion
  // here would delete that cookie too.
  test("refuses it with 403 and does not delete the refresh cookie", async () => {
    const stale = await localSessionCookie(harness, "fid-stale", 1);
    // An enrolment, a password change, or a sign-out everywhere ended it.
    harness.account.securityVersion = 2;

    const res = await refresh(harness, stale);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "session_revoked" });
    expect(harness.redis.store.get("refresh_family:fid-stale")).toBe("revoked");
    expect(refreshSetCookie(res.headers["set-cookie"])).toBeNull();
  });

  test("refuses the same stale cookie again on the next refresh", async () => {
    const stale = await localSessionCookie(harness, "fid-again", 1);
    harness.account.securityVersion = 2;
    await refresh(harness, stale);

    const again = await refresh(harness, stale);

    expect(again.statusCode).toBe(403);
    expect(again.json()).toEqual({ error: "session_revoked" });
    expect(refreshSetCookie(again.headers["set-cookie"])).toBeNull();
  });
});
