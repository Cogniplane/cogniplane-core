import { describe, expect, test } from "vitest";

import { checkPasswordPolicy, normalizePassword } from "./password-policy.js";

describe("checkPasswordPolicy", () => {
  test.each([
    ["too short (14 characters)", "abcdefghijklmn", "password_too_short"],
    ["too long (129 characters)", "a1".repeat(64) + "b", "password_too_long"],
    ["a blocked password", "passwordpassword", "password_too_common"],
    ["a blocked password with spaces and case", "Password Password", "password_too_common"],
    ["one repeated character", "zzzzzzzzzzzzzzzzzz", "password_too_common"],
    ["the email", "xalice@example.comx", "password_contains_email"],
    ["the email's local part", "my name is alice 2026", "password_contains_email"]
  ])("refuses %s", (_case, password, error) => {
    expect(checkPasswordPolicy(password, { email: "alice@example.com" })).toBe(error);
  });

  test("accepts a long passphrase with no composition rules", () => {
    expect(checkPasswordPolicy("purple elephants dance quietly", { email: "alice@example.com" })).toBeNull();
  });

  test("counts characters, not bytes, after NFKC normalisation", () => {
    // 15 code points, but 29 UTF-8 bytes. The length rule counts code points.
    expect(checkPasswordPolicy("é".repeat(14) + "x", { email: null })).toBeNull();
    // A full-width form normalises to its ASCII form.
    expect(normalizePassword("ｐａｓｓｗｏｒｄ")).toBe("password");
  });

  test("a short local part is not treated as part of the password", () => {
    expect(checkPasswordPolicy("the bob of all trades", { email: "bob@example.com" })).toBeNull();
  });
});
