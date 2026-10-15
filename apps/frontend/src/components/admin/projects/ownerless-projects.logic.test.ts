import { describe, expect, it } from "vitest";

import { ApiError } from "../../../lib/api-client";
import { isAdminRequiredError, ownerChoiceLabel, ownerConfirmation, recoveryErrorMessage } from "./ownerless-projects.logic";

const apiError = (status: number, code: string | undefined, message = "From the server") =>
  new ApiError({ status, code, method: "POST", path: "/admin/projects/p1/recover-owner", message });

describe("ownerChoiceLabel", () => {
  it("shows the name and the email, and falls back without repeating them", () => {
    expect(ownerChoiceLabel({ userId: "u1", displayName: "Dana Scully", email: "dana@example.test" })).toBe("Dana Scully (dana@example.test)");
    expect(ownerChoiceLabel({ userId: "u1", displayName: null, email: "dana@example.test" })).toBe("dana@example.test");
    expect(ownerChoiceLabel({ userId: "u1", displayName: null, email: null })).toBe("u1");
  });
});

describe("ownerConfirmation", () => {
  it("says what an owner can do, what stays the same, and that it is audited", () => {
    const confirmation = ownerConfirmation("Q3 planning", "Dana Scully", false);
    expect(confirmation.title).toBe("Make Dana Scully the owner of Q3 planning?");
    expect(confirmation.effects.join(" ")).toContain("open and manage everything in this project");
    expect(confirmation.effects.join(" ")).toContain("keep the access that they have now");
    expect(confirmation.effects.join(" ")).toContain("audit log");
    expect(confirmation.selfWarning).toBeNull();
  });

  it("warns an admin who picks themselves that they will get access to the content", () => {
    expect(ownerConfirmation("Q3 planning", "Fox Mulder", true).selfWarning).toContain("You will get access to everything in this project");
  });
});

describe("recoveryErrorMessage", () => {
  it.each([
    ["project_has_owner", "This project already has an owner."],
    ["organization_member_not_found", "no longer a member of the organization"],
    ["organization_admin_required", "Only organization admins can assign a project owner."],
    ["project_not_found", "This project is not available."]
  ])("explains %s", (code, text) => {
    expect(recoveryErrorMessage(apiError(409, code))).toContain(text);
  });

  it("uses the server message for another code, and a fallback for a plain value", () => {
    expect(recoveryErrorMessage(apiError(500, undefined, "Request failed: 500"))).toBe("Request failed: 500");
    expect(recoveryErrorMessage(new Error("Network down"))).toBe("Network down");
    expect(recoveryErrorMessage("x")).toBe("The owner was not assigned. Try again.");
  });
});

describe("isAdminRequiredError", () => {
  it("is true only for a refusal by role", () => {
    expect(isAdminRequiredError(apiError(403, "organization_admin_required"))).toBe(true);
    expect(isAdminRequiredError(apiError(403, "something_else"))).toBe(true);
    expect(isAdminRequiredError(apiError(500, "internal_error"))).toBe(false);
    expect(isAdminRequiredError(new Error("x"))).toBe(false);
  });
});
