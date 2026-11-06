import nodemailer from "nodemailer";

import { parseEmail } from "../../lib/email-address.js";
import type { MailFrom, SmtpSettings } from "../../lib/smtp-settings.js";

// Sends one message. Only the outbox worker calls it, after the change that
// the message reports has committed. See docs/ARCHITECTURE.md,
// "Authentication".

export type OutgoingMail = { to: string; subject: string; text: string; html: string };

export interface MailSender {
  send(mail: OutgoingMail): Promise<void>;
  close(): void;
}

export type SendFailure = {
  /** An error code and the SMTP reply code, never the server's text (it can repeat the address). */
  code: string;
  /** Sending again gives the same answer: the server refused the recipient or the message. */
  permanent: boolean;
};

export function classifySendError(error: unknown): SendFailure {
  if (error instanceof InvalidRecipientError) return { code: error.code, permanent: true };
  const fields = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown; responseCode?: unknown };
  const code = typeof fields.code === "string" && /^[A-Z][A-Z0-9_]{1,31}$/.test(fields.code) ? fields.code : "ERROR";
  const responseCode = typeof fields.responseCode === "number" && Number.isInteger(fields.responseCode) ? fields.responseCode : null;
  // An authentication or connection failure is the operator's to fix, so it
  // is retried. A 5xx refusal of the recipient or the message is final.
  const permanent = responseCode !== null && responseCode >= 500 && responseCode <= 599 && (code === "EENVELOPE" || code === "EMESSAGE");
  return { code: responseCode === null ? code : `${code} ${responseCode}`, permanent };
}

/** Thrown before any connection when the recipient is not one plain address. */
export class InvalidRecipientError extends Error {
  readonly code = "BAD_ADDRESS";
  readonly permanent = true;

  constructor() {
    super("The recipient is not a single plain email address.");
    this.name = "InvalidRecipientError";
  }
}

type Transport = Pick<ReturnType<typeof nodemailer.createTransport>, "sendMail" | "close">;

export class SmtpMailSender implements MailSender {
  private readonly transport: Transport;

  /** `transport`: tests only, to read the message without a server. */
  constructor(settings: SmtpSettings, private readonly from: MailFrom, transport?: Transport) {
    this.transport = transport ?? nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      requireTLS: settings.requireTLS,
      ...(settings.auth ? { auth: settings.auth } : {}),
      tls: { minVersion: "TLSv1.2", servername: settings.host },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
      // The bodies are our own text; never let a message read a local file or a URL.
      disableFileAccess: true,
      disableUrlAccess: true
    });
  }

  async send(mail: OutgoingMail): Promise<void> {
    // The address must be exactly one plain address. Nodemailer parses
    // address-list text: `alice<attacker@example.test>` would go to the
    // address in the brackets. The explicit envelope keeps the SMTP
    // recipients to this one address whatever the headers say.
    if (parseEmail(mail.to) !== mail.to) throw new InvalidRecipientError();
    await this.transport.sendMail({
      from: this.from.name ? { name: this.from.name, address: this.from.address } : this.from.address,
      to: { name: "", address: mail.to },
      envelope: { from: this.from.address, to: [mail.to] },
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      // RFC 3834: an automatic message. Out-of-office replies skip it.
      headers: { "Auto-Submitted": "auto-generated" }
    });
  }

  close(): void {
    this.transport.close();
  }
}
