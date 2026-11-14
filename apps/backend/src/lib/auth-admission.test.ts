import { describe, expect, test } from "vitest";

import type { TenantAuthState } from "../services/tenant-member-store.js";
import { checkAuthAdmission } from "./auth-admission.js";

const BOTH = { AUTH_LOGIN_TYPES: ["workos", "local"] } as const;
const WORKOS: TenantAuthState = { role: "member", loginType: "workos", authSource: "workos", localStatus: null, securityVersion: null };
const LOCAL: TenantAuthState = { role: "member", loginType: "local", authSource: "local", localStatus: "active", securityVersion: 4 };
const REMOVED_AT = 1_800_000_000.25;

// The tenant's latest removal of the user ends every session that started
// before it (services/tenant-member-removal.ts), also if the membership
// exists again later.
describe("checkAuthAdmission after a removal", () => {
  test("admits a session of a member that the tenant never removed, with or without auth_time", () => {
    expect(checkAuthAdmission(BOTH, WORKOS, {})).toEqual({ ok: true, state: WORKOS });
    expect(checkAuthAdmission(BOTH, WORKOS, { authTime: 1 })).toEqual({ ok: true, state: WORKOS });
  });

  test.each([
    ["started before the removal", Math.floor(REMOVED_AT) - 60],
    ["started in the second of the removal", Math.floor(REMOVED_AT)],
    ["with no auth_time", undefined]
  ])("refuses a WorkOS session %s", (_case, authTime) => {
    const state = { ...WORKOS, removedAt: REMOVED_AT };
    expect(checkAuthAdmission(BOTH, state, authTime === undefined ? {} : { authTime }))
      .toEqual({ ok: false, error: "session_revoked" });
  });

  test("admits a WorkOS session that started after the removal", () => {
    const state = { ...WORKOS, removedAt: REMOVED_AT };
    expect(checkAuthAdmission(BOTH, state, { authTime: Math.floor(REMOVED_AT) + 1 })).toEqual({ ok: true, state });
  });

  test("applies to a local session that carries the current security version", () => {
    const state = { ...LOCAL, removedAt: REMOVED_AT };
    expect(checkAuthAdmission(BOTH, state, { sv: 4, authTime: Math.floor(REMOVED_AT) - 1 }))
      .toEqual({ ok: false, error: "session_revoked" });
    expect(checkAuthAdmission(BOTH, state, { sv: 4, authTime: Math.floor(REMOVED_AT) + 1 })).toEqual({ ok: true, state });
  });

  test("a missing membership stays not_a_member", () => {
    expect(checkAuthAdmission(BOTH, null, { authTime: 1 })).toEqual({ ok: false, error: "not_a_member" });
  });
});
