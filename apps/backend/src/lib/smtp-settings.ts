import { parseEmail } from "./email-address.js";

// Parses the SMTP settings (SMTP_URL, MAIL_FROM). Boot calls these, so a bad
// value stops the start. Error messages never repeat the URL: it can hold a
// password. See docs/ARCHITECTURE.md, "Authentication".

export type SmtpSettings = {
  host: string;
  port: number;
  /** TLS from the first byte (smtps://, usually port 465). */
  secure: boolean;
  /** smtp:// must upgrade with STARTTLS; the send fails when the server cannot. */
  requireTLS: boolean;
  auth?: { user: string; pass: string };
};

export type MailFrom = { name: string | null; address: string };

/**
 * `smtps://user:pass@host:465` (TLS from the start) or
 * `smtp://user:pass@host:587` (STARTTLS required). `allowPlaintext` lets
 * smtp:// continue without TLS, for a local test server in development only.
 */
export function parseSmtpUrl(raw: string, allowPlaintext: boolean): SmtpSettings {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("SMTP_URL is not a valid URL. Use smtps://user:password@host:465 or smtp://user:password@host:587.");
  }
  if (url.protocol !== "smtp:" && url.protocol !== "smtps:") {
    throw new Error("SMTP_URL must start with smtps:// or smtp://.");
  }
  if (!url.hostname) throw new Error("SMTP_URL has no host.");
  if (url.pathname && url.pathname !== "/") throw new Error("SMTP_URL must not have a path.");
  if (url.search || url.hash) throw new Error("SMTP_URL must not have a query or a fragment. Put the TLS choice in the scheme.");
  const secure = url.protocol === "smtps:";
  const port = url.port ? Number(url.port) : secure ? 465 : 587;
  const user = decodeURIComponent(url.username);
  const pass = decodeURIComponent(url.password);
  if (Boolean(user) !== Boolean(pass)) throw new Error("SMTP_URL must have both a user and a password, or neither.");
  return {
    // URL keeps the brackets of an IPv6 literal; the socket needs it without.
    host: url.hostname.replace(/^\[(.*)\]$/, "$1"),
    port,
    secure,
    requireTLS: !secure && !allowPlaintext,
    ...(user ? { auth: { user, pass } } : {})
  };
}

/** `no-reply@example.com` or `Cogniplane <no-reply@example.com>`. */
export function parseMailFrom(raw: string): MailFrom {
  const value = raw.trim();
  if (/[\r\n]/.test(value)) throw new Error("MAIL_FROM must be one line.");
  const named = /^(.*?)\s*<([^<>]+)>$/.exec(value);
  const name = named ? named[1]!.replace(/^"(.*)"$/, "$1").trim() : "";
  const address = parseEmail(named ? named[2] : value);
  if (!address) throw new Error("MAIL_FROM must be an email address, or a name and an address: Cogniplane <no-reply@example.com>.");
  if (/["\\]/.test(name)) throw new Error("MAIL_FROM: the name must not contain quotes or backslashes.");
  return { name: name || null, address };
}
