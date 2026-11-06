import { describe, expect, test } from "vitest";

import { parseBootstrapArguments, parseRecoverOwnerArguments } from "./local-auth-commands-lib.js";

describe("operator command arguments", () => {
  test("bootstrap reads the tenant name, owner email, and optional owner name", () => {
    expect(parseBootstrapArguments(["--tenant-name", " Acme ", "--owner-email", "ceo@acme.test"])).toEqual({
      tenantName: "Acme", ownerEmail: "ceo@acme.test", ownerName: null
    });
    expect(parseBootstrapArguments(["--owner-email", "a@b.co", "--tenant-name", "X", "--owner-name", "Ann"]).ownerName).toBe("Ann");
  });

  test.each([
    ["no arguments", []],
    ["a missing email", ["--tenant-name", "Acme"]],
    ["an unknown flag", ["--tenant-name", "Acme", "--owner-email", "a@b.co", "--dry-run", "yes"]],
    ["a repeated flag", ["--tenant-name", "Acme", "--tenant-name", "Other", "--owner-email", "a@b.co"]],
    ["a flag as a value", ["--tenant-name", "--owner-email", "a@b.co"]]
  ])("bootstrap refuses %s", (_case, argv) => {
    expect(() => parseBootstrapArguments(argv)).toThrow(/Usage: auth:bootstrap/);
  });

  test("recover-owner needs both the tenant and the email", () => {
    expect(parseRecoverOwnerArguments(["--tenant-id", "t1", "--email", "o@t.co"])).toEqual({ tenantId: "t1", email: "o@t.co" });
    expect(() => parseRecoverOwnerArguments(["--tenant-id", "t1"])).toThrow(/Usage: auth:recover-owner/);
  });
});
