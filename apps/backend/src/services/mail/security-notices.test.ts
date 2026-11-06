import { expect, test } from "vitest";

import { formatWhen, headerSafe, renderSecurityNotice, type SecurityNotice } from "./security-notices.js";

const AT = new Date("2026-10-26T14:03:59Z");
const CONTEXT = { to: "max@example.test", displayName: "Max Member", organization: "Acme", at: AT };

const ALL: SecurityNotice[] = [
  { kind: "password_changed" },
  { kind: "factor_added", method: "totp" },
  { kind: "factor_added", method: "passkey" },
  { kind: "factor_removed", method: "totp" },
  { kind: "factor_removed", method: "passkey" },
  { kind: "admin_password_reset" },
  { kind: "admin_factors_reset" }
];

test("every notice names the organization, the account, and the time, and has no link", () => {
  for (const notice of ALL) {
    const mail = renderSecurityNotice(notice, CONTEXT);
    expect(mail.to).toBe("max@example.test");
    expect(mail.subject.startsWith("Acme: ")).toBe(true);
    expect(mail.text).toContain("Hello Max Member,");
    expect(mail.text).toContain("your Acme account (max@example.test)");
    expect(mail.text).toContain("26 October 2026, 14:03 UTC");
    for (const body of [mail.text, mail.html]) {
      expect(body).not.toMatch(/https?:|www\.|<a\b/i);
    }
  }
});

test("the method and the actor are in the text", () => {
  expect(renderSecurityNotice({ kind: "factor_added", method: "totp" }, CONTEXT).text).toContain("An authenticator app was added to your Acme account");
  expect(renderSecurityNotice({ kind: "factor_removed", method: "passkey" }, CONTEXT).text).toContain("A passkey was removed from your Acme account");
  expect(renderSecurityNotice({ kind: "admin_password_reset" }, CONTEXT).text).toContain("An administrator of Acme reset the password of your Acme account");
  expect(renderSecurityNotice({ kind: "admin_factors_reset" }, CONTEXT).text).toContain("At your next sign-in, you must set up a new method.");
});

test("names from the database cannot inject HTML or headers", () => {
  const mail = renderSecurityNotice({ kind: "password_changed" }, {
    ...CONTEXT,
    organization: "Evil\r\nBcc: victim@example.test <b>Org</b>",
    displayName: "<img src=x onerror=alert(1)>"
  });
  expect(mail.subject).not.toMatch(/[\r\n]/);
  expect(mail.subject).toBe("Evil Bcc: victim@example.test <b>Org</b>: Your password was changed");
  expect(mail.html).not.toContain("<img");
  expect(mail.html).not.toContain("<b>");
  expect(mail.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
});

test("no name: a plain greeting; an empty organization: the product name", () => {
  const mail = renderSecurityNotice({ kind: "password_changed" }, { ...CONTEXT, displayName: null, organization: "  " });
  expect(mail.text.startsWith("Hello,\n")).toBe(true);
  expect(mail.subject).toBe("Cogniplane: Your password was changed");
});

test("headerSafe removes control and line-separator characters and shortens", () => {
  expect(headerSafe(`a\u0000b\u2028c\u0085d\te`)).toBe("a b c d e");
  // Format characters go: a right-to-left override (U+202E) would show
  // "moc.elpmaxe@lla" as "all@example.com", and zero-width characters hide text.
  expect(headerSafe("Acme\u202Emoc.live\u202C Corp")).toBe("Acmemoc.live Corp");
  expect(headerSafe("A\u200Bc\u200Dm\u2066e\uFEFF\u00AD")).toBe("Acme");
  expect(headerSafe("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`);
  expect(formatWhen(new Date("2026-01-05T00:07:00Z"))).toBe("5 January 2026, 00:07 UTC");
});
