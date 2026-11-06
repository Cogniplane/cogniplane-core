import { expect, test } from "vitest";

import { type LinkEmailVariant, renderLinkEmail } from "./link-emails.js";

const URL_WITH_TOKEN = `https://app.example.test/auth/reset-password#token=${"a".repeat(43)}`;
const CONTEXT = {
  to: "max@example.test",
  displayName: "Max",
  organization: "Acme",
  at: new Date("2026-10-26T14:03:00Z"),
  url: URL_WITH_TOKEN,
  expiresAt: new Date("2026-10-26T14:33:00Z")
};

const VARIANTS: LinkEmailVariant[] = ["self_reset", "admin_reset", "admin_resend", "setup"];

test("every link email carries the link once, its expiry, and what to do when it was not expected", () => {
  for (const variant of VARIANTS) {
    const mail = renderLinkEmail(variant, CONTEXT);
    expect(mail.to).toBe("max@example.test");
    expect(mail.subject.startsWith("Acme: ")).toBe(true);
    expect(mail.text).toContain(`\n\n${URL_WITH_TOKEN}\n\n`);
    expect(mail.text).toContain("until 26 October 2026, 14:33 UTC");
    expect(mail.text).toContain("Hello Max,");
    expect(mail.html.match(/<a /g)).toHaveLength(1);
    expect(mail.html).toContain(`href="${URL_WITH_TOKEN}"`);
  }
});

test("each variant says who asked and what already happened", () => {
  const self = renderLinkEmail("self_reset", CONTEXT);
  expect(self.subject).toBe("Acme: Reset your password");
  expect(self.text).toContain("Somebody asked to reset the password of your Acme account (max@example.test) on 26 October 2026, 14:03 UTC");
  expect(self.text).toContain("If you did not ask for this, ignore this message.");

  const reset = renderLinkEmail("admin_reset", CONTEXT);
  expect(reset.subject).toBe("Acme: Your administrator reset your password");
  expect(reset.text).toContain("You were signed out on all devices.");
  expect(reset.text).toContain("Until you use it, your current password continues to work.");

  const resend = renderLinkEmail("admin_resend", CONTEXT);
  expect(resend.subject).toBe("Acme: A link to choose a new password");
  expect(resend.text).not.toContain("signed out");

  const setup = renderLinkEmail("setup", CONTEXT);
  expect(setup.subject).toBe("Acme: Set up your account");
  expect(setup.text).toContain("An administrator of Acme made an account for you (max@example.test)");
  expect(setup.html).toContain(">Set up your account</a>");
});

test("names from the database cannot inject HTML or headers", () => {
  const mail = renderLinkEmail("setup", { ...CONTEXT, organization: "Evil\r\nBcc: x@example.test", displayName: '"><script>alert(1)</script>' });
  expect(mail.subject).not.toMatch(/[\r\n]/);
  expect(mail.html).not.toContain("<script>");
  expect(mail.html).toContain("&quot;&gt;&lt;script&gt;");
});
