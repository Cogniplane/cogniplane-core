import { type AppConfig, isMailEnabled } from "../../config.js";
import type { Pool } from "../../lib/db.js";
import { parseMailFrom, parseSmtpUrl } from "../../lib/smtp-settings.js";
import { MailOutboxWorker } from "./mail-outbox-worker.js";
import { SmtpMailSender } from "./mail-sender.js";

/**
 * The outbox worker in AUTH_MODE=jwt, for every login type: local accounts
 * get notices and links, and every owner gets the notice of a data setting
 * change. Without SMTP_URL and MAIL_FROM it has no sender: it only expires
 * and deletes rows left from a time when email was on.
 */
export function buildMailWorker(
  config: AppConfig,
  /** Maintenance pool. */
  db: Pool,
  logger: ConstructorParameters<typeof MailOutboxWorker>[0]["logger"]
): MailOutboxWorker | null {
  if (config.AUTH_MODE !== "jwt") return null;
  const sender = isMailEnabled(config)
    ? new SmtpMailSender(parseSmtpUrl(config.SMTP_URL!, config.SMTP_ALLOW_PLAINTEXT), parseMailFrom(config.MAIL_FROM!))
    : null;
  return new MailOutboxWorker({ db, sender, secret: config.DATA_ENCRYPTION_SECRET, logger });
}
