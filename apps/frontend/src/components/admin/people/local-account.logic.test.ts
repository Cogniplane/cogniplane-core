import { describe, expect, it } from "vitest";

import { accountStatusOf, linkEmailSummary, mayResendLink, newPersonRoles, signInLockReason } from "./local-account.logic";

describe("local account rules", () => {
  const owner = { userId: "o", role: "owner" as const };
  const admin = { userId: "a", role: "admin" as const };

  it("mirrors the backend rights", () => {
    expect(signInLockReason(admin, { userId: "a", role: "admin" })).toMatch(/your own sign-in/i);
    expect(signInLockReason(owner, { userId: "x", role: "owner" })).toMatch(/owner/i);
    expect(signInLockReason(admin, { userId: "x", role: "admin" })).toMatch(/only owners/i);
    expect(signInLockReason(owner, { userId: "x", role: "admin" })).toBeNull();
    expect(signInLockReason(admin, { userId: "x", role: "member" })).toBeNull();
    expect(signInLockReason({ userId: "m", role: "member" }, { userId: "x", role: "member" })).toMatch(/only owners and admins/i);
  });

  it("lets only an owner add an admin, and nobody add an owner", () => {
    expect(newPersonRoles(owner)).toEqual(["member", "admin"]);
    expect(newPersonRoles(admin)).toEqual(["member"]);
  });

  it("has no sign-in status for WorkOS members or removed accounts", () => {
    expect(accountStatusOf({ accountStatus: null })).toBeNull();
    expect(accountStatusOf({})).toBeNull();
    expect(accountStatusOf({ accountStatus: "removed" })).toBeNull();
    expect(accountStatusOf({ accountStatus: "disabled" })).toBe("disabled");
  });
});

describe("link email status", () => {
  const at = "2026-10-26T10:00:00.000Z";
  it("says what happened to the latest link email, with a reason from the code only", () => {
    expect(linkEmailSummary({ purpose: "account_setup", status: "queued", updatedAt: at, error: null })).toBe("The setup link email is waiting to be sent.");
    expect(linkEmailSummary({ purpose: "password_reset", status: "queued", updatedAt: at, error: "ECONNECTION" }))
      .toBe("The password reset link email is waiting to be sent again (the mail server could not be reached).");
    expect(linkEmailSummary({ purpose: "account_setup", status: "sent", updatedAt: at, error: null })).toMatch(/^The setup link email went out /);
    expect(linkEmailSummary({ purpose: "account_setup", status: "failed", updatedAt: at, error: "BAD_ADDRESS" }))
      .toBe("The setup link email could not be sent: the address is not a valid email address.");
    expect(linkEmailSummary({ purpose: "account_setup", status: "failed", updatedAt: at, error: "EMESSAGE 552" }))
      .toBe("The setup link email could not be sent: the mail server refused the message.");
    expect(linkEmailSummary({ purpose: "password_reset", status: "expired", updatedAt: at, error: null }))
      .toBe("The password reset link email was not sent: its link ended first (it expired or was replaced).");
  });

  it("offers a resend for an account not set up yet, or when the last email did not go out", () => {
    const sent = { purpose: "password_reset" as const, status: "sent" as const, updatedAt: at, error: null };
    expect(mayResendLink("pending_setup", null)).toBe(true);
    expect(mayResendLink("active", null)).toBe(false);
    expect(mayResendLink("active", sent)).toBe(false);
    expect(mayResendLink("active", { ...sent, status: "failed" })).toBe(true);
    expect(mayResendLink("active", { ...sent, status: "expired" })).toBe(true);
    expect(mayResendLink("disabled", { ...sent, status: "failed" })).toBe(false);
  });
});
