import type { OutgoingMail } from "./mail-sender.js";

// The texts of the security notices. A notice says what changed and when,
// and what to do if the person did not make the change. It has no link: a
// message that tells people to click is what a phishing message looks like.
// See docs/architecture/email.md.

export type SecondFactorMethod = "totp" | "passkey";

export type SecurityNotice =
  | { kind: "password_changed" }
  | { kind: "factor_added"; method: SecondFactorMethod }
  | { kind: "factor_removed"; method: SecondFactorMethod }
  | { kind: "admin_password_reset" }
  | { kind: "admin_factors_reset" };

export type NoticeContext = {
  to: string;
  displayName: string | null;
  organization: string;
  at: Date;
};

const METHOD_NAME: Record<SecondFactorMethod, string> = {
  totp: "An authenticator app",
  passkey: "A passkey"
};

const NOT_YOU = "If you did not make this change, contact your administrator immediately. Somebody else can have access to your account.";
export const FOOTER = "This is an automatic security message from Cogniplane. Do not reply to it.";

type Body = { subject: string; paragraphs: string[] };

function body(notice: SecurityNotice, context: NoticeContext, when: string): Body {
  const account = `your ${context.organization} account (${context.to})`;
  switch (notice.kind) {
    case "password_changed":
      return {
        subject: "Your password was changed",
        paragraphs: [`The password of ${account} was changed on ${when}.`, "If you made this change, you do not need to do anything.", NOT_YOU]
      };
    case "factor_added":
      return {
        subject: "A two-step verification method was added",
        paragraphs: [`${METHOD_NAME[notice.method]} was added to ${account} on ${when}. It can now be used to sign in.`, "If you made this change, you do not need to do anything.", NOT_YOU]
      };
    case "factor_removed":
      return {
        subject: "A two-step verification method was removed",
        paragraphs: [`${METHOD_NAME[notice.method]} was removed from ${account} on ${when}.`, "If you made this change, you do not need to do anything.", NOT_YOU]
      };
    case "admin_password_reset":
      return {
        subject: "An administrator reset your password",
        paragraphs: [
          `An administrator of ${context.organization} reset the password of ${account} on ${when}. You were signed out on all devices.`,
          "A separate email brings a link to choose a new password. Until you use it, your current password continues to work.",
          "If you did not expect this, speak to your administrator."
        ]
      };
    case "admin_factors_reset":
      return {
        subject: "An administrator removed your two-step verification",
        paragraphs: [
          `An administrator of ${context.organization} removed the two-step verification methods of ${account} on ${when}. You were signed out on all devices.`,
          "At your next sign-in, you must set up a new method.",
          "If you did not expect this, speak to your administrator."
        ]
      };
  }
}

/**
 * One line, no control characters, a sensible length: safe in a subject.
 * Unicode format characters (category Cf: bidirectional overrides such as
 * U+202E, zero-width characters, the byte order mark) are removed: they can
 * make a name show other text than it holds, for example a reversed address.
 */
export function headerSafe(value: string, max = 80): string {
  const clean = value
    .replace(/\p{Cf}+/gu, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** "26 October 2026, 14:03 UTC": one form for every reader, whatever the time zone. */
export function formatWhen(at: Date): string {
  const date = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(at);
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" }).format(at);
  return `${date}, ${time} UTC`;
}

export function renderSecurityNotice(notice: SecurityNotice, context: NoticeContext): OutgoingMail {
  const organization = headerSafe(context.organization) || "Cogniplane";
  const safe = { ...context, organization, displayName: context.displayName ? headerSafe(context.displayName) : null };
  const { subject, paragraphs } = body(notice, safe, formatWhen(context.at));
  const greeting = safe.displayName ? `Hello ${safe.displayName},` : "Hello,";
  const text = [greeting, ...paragraphs, FOOTER].join("\n\n") + "\n";
  const html = [
    "<!doctype html>",
    '<html><body style="font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.5; color: #1f2328;">',
    ...[greeting, ...paragraphs].map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`),
    `<p style="color: #59636e; font-size: 13px;">${escapeHtml(FOOTER)}</p>`,
    "</body></html>"
  ].join("\n");
  return { to: context.to, subject: `${organization}: ${subject}`, text, html };
}
