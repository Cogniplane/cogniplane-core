import { describe, expect, test } from "vitest";

import { normalizeEmail, parseEmail } from "./email-address.js";

describe("email addresses", () => {
  test("normalises to NFC, trimmed, lowercase, with no provider rules", () => {
    expect(normalizeEmail("  Alice.Smith+Work@Gmail.COM ")).toBe("alice.smith+work@gmail.com");
    // e + combining acute becomes the single é code point.
    expect(normalizeEmail("rené@example.com")).toBe("rené@example.com");
  });

  test.each([
    "", "no-at-sign", "two@@example.com", "a@b", "spaces in@example.com", `${"x".repeat(250)}@e.co`, 42,
    // Address-list syntax: a mail library would send to another mailbox.
    "alice<attacker@example.test>", "a,b@example.test", "a@example.test;b@example.test", '"a"@example.test',
    "a(comment)@example.test", "a@[127.0.0.1]", "a:b@example.test", "a\\b@example.test", "a\u0001b@example.test"
  ])(
    "refuses %s",
    (raw) => {
      expect(parseEmail(raw)).toBeNull();
    }
  );

  test("accepts a normal address", () => {
    expect(parseEmail(" Bob@Example.org ")).toBe("bob@example.org");
  });
});
