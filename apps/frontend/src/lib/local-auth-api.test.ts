import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, request } from "./api-client";
import { createLocalMember, enableMember, isStepUpRefusal, LocalAuthError } from "./local-auth-api";

vi.mock("./api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api-client")>();
  return { ...actual, request: vi.fn() };
});
beforeEach(() => {
  vi.mocked(request).mockReset();
});

// The backend refuses these manager actions without the manager's step-up
// token (apps/backend/src/services/auth/step-up-routes.ts).
describe("manager actions that need step-up", () => {
  it("member creation sends the step-up token", async () => {
    vi.mocked(request).mockResolvedValue({ userId: "new-user", link: null, email: { to: "new@example.test", expiresAt: "2026-10-31T10:00:00.000Z", purpose: "account_setup" } });
    await createLocalMember({ email: "new@example.test", role: "member" }, "step-up-token");
    expect(vi.mocked(request)).toHaveBeenCalledWith("/tenant/members", expect.objectContaining({
      method: "POST", headers: { "X-Step-Up": "step-up-token" }
    }));
  });

  it("enable sends the step-up token", async () => {
    vi.mocked(request).mockResolvedValue({ status: "active" });
    expect(await enableMember("dana", "step-up-token")).toBe("active");
    expect(vi.mocked(request)).toHaveBeenCalledWith("/tenant/members/dana/enable", expect.objectContaining({
      method: "POST", headers: { "X-Step-Up": "step-up-token" }
    }));
  });
});

describe("isStepUpRefusal", () => {
  it.each([
    [new ApiError({ status: 403, code: "step_up_required", method: "POST", path: "/x", message: "x" }), true],
    [new LocalAuthError("strong_step_up_required", 403), true],
    [new ApiError({ status: 409, code: "account_not_active", method: "POST", path: "/x", message: "x" }), false],
    [new Error("network"), false]
  ])("%s → %s", (error, expected) => {
    expect(isStepUpRefusal(error)).toBe(expected);
  });
});
