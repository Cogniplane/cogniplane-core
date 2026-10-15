import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminPersonAccessResponseSchema } from "@cogniplane/shared-types";

import { getAdminPersonAccess } from "./admin-api";
import { request } from "./api-client";

vi.mock("./api-client", () => ({ request: vi.fn(), requestOptionalOn404: vi.fn() }));

const excludedSkill = {
  kind: "skill", id: "contract-review", name: "Contract review",
  runtimeSource: null, adminPageSource: "organization", signIn: null, status: "excluded",
  gates: [
    { gate: "visible_to_member", result: "fail", reason: "test_users_only" },
    { gate: "allowed_for_organization", result: "not_checked" },
    { gate: "in_member_defaults", result: "not_checked" },
    { gate: "has_instructions", result: "not_checked" }
  ]
};
const unknownConnection = {
  kind: "connection", id: "search", name: "Search",
  runtimeSource: "system", adminPageSource: "system", signIn: "personal", status: "unknown",
  gates: [
    { gate: "visible_to_member", result: "pass" },
    { gate: "allowed_for_organization", result: "pass" },
    { gate: "in_member_defaults", result: "pass" },
    { gate: "personal_sign_in", result: "unknown", reason: "legacy_settings_pending" }
  ]
};
const body = () => ({
  tenantId: "tenant-a", userId: "dana", scope: "new_standalone_chat", checkedAt: "2026-09-27T12:00:00.000Z",
  member: { isTestUser: false, defaults: "custom" },
  notCovered: ["projects", "live_connection_health"],
  items: [structuredClone(excludedSkill), structuredClone(unknownConnection)]
});

describe("AdminPersonAccessResponseSchema", () => {
  it("accepts the documented shape and emits an ISO timestamp for a Date", () => {
    const parsed = AdminPersonAccessResponseSchema.parse({ ...body(), checkedAt: new Date("2026-09-27T12:00:00Z") });
    expect(parsed.checkedAt).toBe("2026-09-27T12:00:00.000Z");
    expect(parsed.items).toHaveLength(2);
  });

  it.each([
    ["an extra top-level field", (b: ReturnType<typeof body>) => Object.assign(b, { instructions: "x" })],
    ["an extra member field", (b: ReturnType<typeof body>) => Object.assign(b.member, { email: "x" })],
    ["an extra item field", (b: ReturnType<typeof body>) => Object.assign(b.items[0]!, { bundlePath: "/x" })],
    ["an extra check field", (b: ReturnType<typeof body>) => Object.assign(b.items[0]!.gates[0]!, { credentialLabel: "x" })],
    ["another scope", (b: ReturnType<typeof body>) => Object.assign(b, { scope: "project_chat" })],
    ["an unknown reason", (b: ReturnType<typeof body>) => Object.assign(b.items[0]!.gates[0]!, { reason: "admin_said_no" })],
    ["an unknown exclusion", (b: ReturnType<typeof body>) => Object.assign(b, { notCovered: ["everything"] })],
    ["a null reason", (b: ReturnType<typeof body>) => Object.assign(b.items[0]!.gates[0]!, { reason: null })]
  ])("rejects %s", (_label, mutate) => {
    const value = body();
    mutate(value);
    expect(AdminPersonAccessResponseSchema.safeParse(value).success).toBe(false);
  });

  it("allows a reason only on a failed or unknown check", () => {
    const value = body();
    Object.assign(value.items[1]!.gates[0]!, { reason: "turned_off" });
    expect(AdminPersonAccessResponseSchema.safeParse(value).success).toBe(false);
  });

  it("rejects a repeated check", () => {
    const value = body();
    value.items[1]!.gates.push({ gate: "visible_to_member", result: "pass" });
    expect(AdminPersonAccessResponseSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    ["included with a failed check", 0, "included"],
    ["excluded without a failed check", 1, "excluded"],
    ["unknown with a failed check", 0, "unknown"],
    ["included with an unknown check", 1, "included"]
  ] as const)("rejects a status that disagrees with the checks: %s", (_label, index, status) => {
    const value = body();
    Object.assign(value.items[index]!, { status });
    expect(AdminPersonAccessResponseSchema.safeParse(value).success).toBe(false);
  });
});

describe("getAdminPersonAccess", () => {
  beforeEach(() => { vi.mocked(request).mockReset(); });

  it("reads the member's result from the encoded member path", async () => {
    vi.mocked(request).mockResolvedValue({ ...body(), userId: "a/b" });
    const result = await getAdminPersonAccess("a/b", { tenantId: "tenant-a" });
    expect(vi.mocked(request)).toHaveBeenCalledWith("/admin/users/a%2Fb/skills-connections");
    expect(result.userId).toBe("a/b");
  });

  it.each([
    ["another member", { userId: "fox" }],
    ["another organization", { tenantId: "tenant-b" }]
  ])("rejects a result for %s instead of showing it as this person's access", async (_label, override) => {
    vi.mocked(request).mockResolvedValue({ ...body(), ...override });
    await expect(getAdminPersonAccess("dana", { tenantId: "tenant-a" })).rejects.toThrow("different person or organization");
  });

  it("rejects a malformed body", async () => {
    vi.mocked(request).mockResolvedValue({ ...body(), items: "none" });
    await expect(getAdminPersonAccess("dana", { tenantId: "tenant-a" })).rejects.toThrow();
  });
});
