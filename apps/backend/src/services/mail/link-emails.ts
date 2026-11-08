import type { OutgoingMail } from "./mail-sender.js";
import { escapeHtml, FOOTER, formatWhen, headerSafe } from "./security-notices.js";

// The texts of the emails that carry a one-time link. The link is the only
// way to act on the account from the email; the text says who asked for it,
// how long it works, and what to do when the person did not expect it. See
// docs/architecture/email.md.

/**
 * self_reset: the person asked on the sign-in page ("Forgot password").
 * admin_reset: a manager reset the password; every session ended.
 * admin_resend: a manager sent a new reset link; nothing else changed.
 * setup: a new account, or a new setup link for one not set up yet.
 */
export type LinkEmailVariant = "self_reset" | "admin_reset" | "admin_resend" | "setup";

export type LinkEmailContext = {
  to: string;
  displayName: string | null;
  organization: string;
  /** When the link was issued. */
  at: Date;
  url: string;
  expiresAt: Date;
};

type Text = { subject: string; intro: string; action: string; rules: string; notYou: string };

function text(variant: LinkEmailVariant, organization: string, context: LinkEmailContext): Text {
  const account = `your ${organization} account (${context.to})`;
  const when = formatWhen(context.at);
  const until = formatWhen(context.expiresAt);
  switch (variant) {
    case "self_reset":
      return {
        subject: "Reset your password",
        intro: `Somebody asked to reset the password of ${account} on ${when}. If it was you, open this link to choose a new password:`,
        action: "Choose a new password",
        rules: `The link works once, until ${until}. When you save the new password, you are signed out on all devices. Your two-step verification does not change.`,
        notYou: "If you did not ask for this, ignore this message. Your password stays the same."
      };
    case "admin_reset":
      return {
        subject: "Your administrator reset your password",
        intro: `An administrator of ${organization} reset the password of ${account} on ${when}. You were signed out on all devices. Open this link to choose a new password:`,
        action: "Choose a new password",
        rules: `The link works once, until ${until}. Until you use it, your current password continues to work. Your two-step verification does not change.`,
        notYou: "If you did not expect this, speak to your administrator."
      };
    case "admin_resend":
      return {
        subject: "A link to choose a new password",
        intro: `An administrator of ${organization} sent you a link on ${when} to choose a new password for ${account}. Open it to choose a new password:`,
        action: "Choose a new password",
        rules: `The link works once, until ${until}. Until you use it, your current password continues to work. Your two-step verification does not change.`,
        notYou: "If you did not expect this, ignore this message and speak to your administrator."
      };
    case "setup":
      return {
        subject: "Set up your account",
        intro: `An administrator of ${organization} made an account for you (${context.to}) on ${when}. Open this link to choose your password:`,
        action: "Set up your account",
        rules: `The link works once, until ${until}. After that, ask your administrator for a new one.`,
        notYou: "If you did not expect this, ignore this message."
      };
  }
}

export function renderLinkEmail(variant: LinkEmailVariant, context: LinkEmailContext): OutgoingMail {
  const organization = headerSafe(context.organization) || "Cogniplane";
  const displayName = context.displayName ? headerSafe(context.displayName) : null;
  const greeting = displayName ? `Hello ${displayName},` : "Hello,";
  const { subject, intro, action, rules, notYou } = text(variant, organization, context);
  const plain = [greeting, intro, context.url, rules, notYou, FOOTER].join("\n\n") + "\n";
  const html = [
    "<!doctype html>",
    '<html><body style="font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.5; color: #1f2328;">',
    `<p>${escapeHtml(greeting)}</p>`,
    `<p>${escapeHtml(intro)}</p>`,
    `<p><a href="${escapeHtml(context.url)}">${escapeHtml(action)}</a></p>`,
    `<p style="font-size: 13px; color: #59636e; word-break: break-all;">${escapeHtml(context.url)}</p>`,
    `<p>${escapeHtml(rules)}</p>`,
    `<p>${escapeHtml(notYou)}</p>`,
    `<p style="color: #59636e; font-size: 13px;">${escapeHtml(FOOTER)}</p>`,
    "</body></html>"
  ].join("\n");
  return { to: context.to, subject: `${organization}: ${subject}`, text: plain, html };
}
