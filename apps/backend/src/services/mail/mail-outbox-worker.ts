import { randomBytes } from "node:crypto";

import { decrypt } from "../../lib/crypto-utils.js";
import type { Pool } from "../../lib/db.js";
import { classifySendError, type MailSender, type OutgoingMail, type SendFailure } from "./mail-sender.js";

// Sends what email_outbox holds. Runs in every backend process, on the
// maintenance pool (it serves every tenant). See docs/ARCHITECTURE.md,
// "Authentication".
//
// - Claim: FOR UPDATE SKIP LOCKED, so two processes never take one row. A
//   claim carries a random token; only the claimer can finish the row.
// - Send outside any transaction, then finish the row: sent, retry later
//   (with backoff), or failed. The message text is cleared when the row is
//   sent, failed, or expired.
// - At least once: a process that stops after the SMTP server accepted a
//   message, but before the row is finished, leaves a claim that expires; the
//   message is then sent again. A duplicate notice is better than none.
// - A queued message past its expiry is not sent; it becomes `expired`. So
//   is a link email whose link no longer works (used, replaced, expired, or
//   from an older security version): the check runs at expiry and at claim.
// - Finished rows are deleted after RETENTION_MS.
// - Without a sender (email turned off after it was on), the worker still
//   expires queued messages and deletes finished rows, so their data does not
//   stay; it sends nothing.
// - stop() ends a pass between steps: claimed messages not yet sent go back
//   to the queue for the next process.

export const MAIL_POLL_INTERVAL_MS = 5_000;
/** Without a sender there is only cleanup to do. */
export const MAIL_CLEANUP_INTERVAL_MS = 60_000;
const BATCH_SIZE = 10;
const MAX_ATTEMPTS = 10;
const CLAIM_LEASE_MS = 10 * 60_000;
const RETENTION_MS = 30 * 24 * 60 * 60_000;
const PURGE_EVERY_MS = 60 * 60_000;
const PURGE_BATCH = 500;
// Batches one pass may delete; a backlog larger than this continues next pass.
const PURGE_MAX_BATCHES = 20;

/**
 * SQL condition on an `email_outbox` row: it carries no link, or its link can
 * still be redeemed (same checks as redemption, less the account status).
 */
const LINK_STILL_WORKS = `(
  email_outbox.token_hash IS NULL OR EXISTS (
    SELECT 1 FROM auth_action_tokens t
    JOIN local_identities li ON li.tenant_id = t.tenant_id AND li.user_id = t.user_id
    WHERE t.token_hash = email_outbox.token_hash AND t.used_at IS NULL AND t.expires_at > now()
      AND t.security_version = li.security_version
  )
)`;

/** 1, 2, 4, ... minutes, at most one hour. */
export function retryDelayMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 60 * 60_000);
}

type ClaimedRow = { tenant_id: string; email_id: string; kind: string; message_encrypted: string; attempts: number };

type Logger = {
  info(payload: unknown, message: string): void;
  warn(payload: unknown, message: string): void;
  error(payload: unknown, message: string): void;
};

export class MailOutboxWorker {
  private interval: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private stopping = false;
  private lastPurgeMs = 0;

  constructor(
    private readonly deps: {
      /** Maintenance pool (BYPASSRLS). */
      db: Pool;
      /** Null when email is off: expiry and purge only. */
      sender: MailSender | null;
      secret: string;
      logger: Logger;
      now?: () => number;
    }
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  start(intervalMs = this.deps.sender ? MAIL_POLL_INTERVAL_MS : MAIL_CLEANUP_INTERVAL_MS): void {
    if (this.interval) return;
    this.interval = setInterval(() => void this.tick(), intervalMs);
    this.interval.unref();
  }

  stop(): void {
    this.stopping = true;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  /** After stop() and drain(): closes the SMTP connections. */
  close(): void {
    this.deps.sender?.close();
  }

  /** Waits up to `budgetMs` for the tick in progress. True when none is left. */
  async drain(budgetMs: number): Promise<boolean> {
    const running = this.running;
    if (!running) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = await Promise.race([
      running.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), budgetMs); })
    ]);
    clearTimeout(timer);
    return done;
  }

  /** One pass. A pass that is still running makes the next one a no-op. */
  tick(): Promise<void> {
    if (this.running || this.stopping) return this.running ?? Promise.resolve();
    this.running = this.runTick()
      .catch((error: unknown) => this.deps.logger.error({ error }, "Mail outbox pass failed"))
      .finally(() => { this.running = null; });
    return this.running;
  }

  private async runTick(): Promise<void> {
    await this.expireOld();
    if (this.stopping) return;
    await this.recoverStaleClaims();
    if (this.stopping) return;
    if (this.now() - this.lastPurgeMs >= PURGE_EVERY_MS) {
      // Wait an hour only once nothing is left to delete.
      if (await this.purgeFinished()) this.lastPurgeMs = this.now();
    }
    const sender = this.deps.sender;
    if (!sender || this.stopping) return;
    const claimToken = randomBytes(16).toString("hex");
    const claimed = await this.claim(claimToken);
    for (const row of claimed) {
      if (this.stopping) {
        await this.releaseClaims(claimToken);
        return;
      }
      await this.deliver(sender, row, claimToken);
    }
  }

  /** Puts this pass's unsent claims back in the queue, as if never tried. */
  private async releaseClaims(claimToken: string): Promise<void> {
    await this.deps.db.query(
      `
        UPDATE email_outbox
        SET status = 'queued', attempts = attempts - 1, claim_token = NULL, claimed_at = NULL, updated_at = now()
        WHERE claim_token = $1 AND status = 'sending'
      `,
      [claimToken]
    );
  }

  /**
   * Claims the next batch. Link emails (setup and reset links) go first:
   * their links expire (30 minutes for a reset), and a backlog of notices,
   * for example from one tenant with many owners, must not keep them waiting.
   * Then the tenants take turns: the first message of every tenant comes
   * before the second message of any tenant, so one tenant's backlog does
   * not delay the others. In each group, the oldest due message comes first.
   */
  private async claim(claimToken: string): Promise<ClaimedRow[]> {
    const result = await this.deps.db.query<ClaimedRow>(
      `
        WITH waiting AS (
          SELECT tenant_id, email_id, next_attempt_at,
                 kind IN ('password_reset_link', 'account_setup_link') AS is_link,
                 row_number() OVER (
                   PARTITION BY tenant_id
                   ORDER BY kind IN ('password_reset_link', 'account_setup_link') DESC, next_attempt_at
                 ) AS turn
          FROM email_outbox
          WHERE status = 'queued' AND next_attempt_at <= now() AND expires_at > now()
            AND ${LINK_STILL_WORKS}
        ),
        due AS (
          SELECT o.tenant_id, o.email_id
          FROM email_outbox o
          JOIN waiting w ON w.tenant_id = o.tenant_id AND w.email_id = o.email_id
          WHERE o.status = 'queued'
          ORDER BY w.is_link DESC, w.turn, w.next_attempt_at
          LIMIT $1
          FOR UPDATE OF o SKIP LOCKED
        )
        UPDATE email_outbox o
        SET status = 'sending', attempts = o.attempts + 1, claim_token = $2, claimed_at = now(), updated_at = now()
        FROM due
        WHERE o.tenant_id = due.tenant_id AND o.email_id = due.email_id
        RETURNING o.tenant_id, o.email_id, o.kind, o.message_encrypted, o.attempts
      `,
      [BATCH_SIZE, claimToken]
    );
    return result.rows;
  }

  private async deliver(sender: MailSender, row: ClaimedRow, claimToken: string): Promise<void> {
    const log = { tenantId: row.tenant_id, emailId: row.email_id, kind: row.kind, attempts: row.attempts };
    let mail: OutgoingMail;
    try {
      mail = JSON.parse(decrypt(row.message_encrypted, this.deps.secret)) as OutgoingMail;
    } catch {
      // DATA_ENCRYPTION_SECRET changed since the message was queued.
      await this.finish(row, claimToken, { kind: "failed", code: "DECRYPT_FAILED" });
      this.deps.logger.error(log, "Mail outbox message cannot be decrypted; marked failed");
      return;
    }
    // Checked again just before the send: an earlier send of this batch can
    // take long, and the link can be replaced or used meanwhile, or the claim
    // can expire and pass to another process.
    const state = await this.stateBeforeSend(row, claimToken);
    if (state === "not_ours") return;
    // stop() can come during that query: hand the claims back, send nothing.
    if (this.stopping) {
      await this.releaseClaims(claimToken);
      return;
    }
    if (state === "dead") {
      await this.finish(row, claimToken, { kind: "expired" });
      this.deps.logger.info(log, "Mail not sent: its link no longer works or it expired");
      return;
    }
    let failure: SendFailure | null = null;
    try {
      await sender.send(mail);
    } catch (error) {
      failure = classifySendError(error);
    }
    if (!failure) {
      await this.finish(row, claimToken, { kind: "sent" });
      this.deps.logger.info(log, "Mail sent");
      return;
    }
    if (failure.permanent || row.attempts >= MAX_ATTEMPTS) {
      await this.finish(row, claimToken, { kind: "failed", code: failure.code });
      this.deps.logger.error({ ...log, code: failure.code }, "Mail send failed; giving up");
      return;
    }
    await this.finish(row, claimToken, { kind: "retry", code: failure.code, delayMs: retryDelayMs(row.attempts) });
    this.deps.logger.warn({ ...log, code: failure.code }, "Mail send failed; will retry");
  }

  private async stateBeforeSend(row: ClaimedRow, claimToken: string): Promise<"deliverable" | "dead" | "not_ours"> {
    const result = await this.deps.db.query<{ deliverable: boolean }>(
      `
        SELECT (expires_at > now() AND ${LINK_STILL_WORKS}) AS deliverable
        FROM email_outbox
        WHERE tenant_id = $1 AND email_id = $2 AND claim_token = $3
      `,
      [row.tenant_id, row.email_id, claimToken]
    );
    const found = result.rows[0];
    if (!found) return "not_ours";
    return found.deliverable ? "deliverable" : "dead";
  }

  private async finish(
    row: ClaimedRow,
    claimToken: string,
    outcome: { kind: "sent" } | { kind: "expired" } | { kind: "failed"; code: string } | { kind: "retry"; code: string; delayMs: number }
  ): Promise<void> {
    const keys = [row.tenant_id, row.email_id, claimToken];
    // The claim token in each WHERE: a claim that expired and was taken by
    // another pass is not this pass's to finish.
    if (outcome.kind === "sent") {
      await this.deps.db.query(
        `
          UPDATE email_outbox
          SET status = 'sent', sent_at = now(), message_encrypted = NULL, claim_token = NULL, claimed_at = NULL,
              last_error = NULL, updated_at = now()
          WHERE tenant_id = $1 AND email_id = $2 AND claim_token = $3
        `,
        keys
      );
    } else if (outcome.kind === "expired") {
      await this.deps.db.query(
        `
          UPDATE email_outbox
          SET status = 'expired', message_encrypted = NULL, claim_token = NULL, claimed_at = NULL, updated_at = now()
          WHERE tenant_id = $1 AND email_id = $2 AND claim_token = $3
        `,
        keys
      );
    } else if (outcome.kind === "failed") {
      await this.deps.db.query(
        `
          UPDATE email_outbox
          SET status = 'failed', message_encrypted = NULL, claim_token = NULL, claimed_at = NULL,
              last_error = $4, updated_at = now()
          WHERE tenant_id = $1 AND email_id = $2 AND claim_token = $3
        `,
        [...keys, outcome.code]
      );
    } else {
      await this.deps.db.query(
        `
          UPDATE email_outbox
          SET status = 'queued', claim_token = NULL, claimed_at = NULL, last_error = $4,
              next_attempt_at = now() + ($5::int * interval '1 millisecond'), updated_at = now()
          WHERE tenant_id = $1 AND email_id = $2 AND claim_token = $3
        `,
        [...keys, outcome.code, outcome.delayMs]
      );
    }
  }

  /** Queued messages past their expiry are not sent. */
  private async expireOld(): Promise<void> {
    const result = await this.deps.db.query(
      `
        UPDATE email_outbox
        SET status = 'expired', message_encrypted = NULL, updated_at = now()
        WHERE status = 'queued' AND (expires_at <= now() OR NOT ${LINK_STILL_WORKS})
      `
    );
    if (result.rowCount) this.deps.logger.warn({ expired: result.rowCount }, "Mail outbox messages expired before they were sent");
  }

  /** A claim older than the lease: its process stopped. Queue it again, or fail it after the last attempt. */
  private async recoverStaleClaims(): Promise<void> {
    const result = await this.deps.db.query(
      `
        UPDATE email_outbox
        SET status = CASE WHEN attempts >= $2 THEN 'failed' ELSE 'queued' END,
            message_encrypted = CASE WHEN attempts >= $2 THEN NULL ELSE message_encrypted END,
            claim_token = NULL, claimed_at = NULL, last_error = 'CLAIM_EXPIRED', next_attempt_at = now(), updated_at = now()
        WHERE status = 'sending' AND claimed_at < now() - ($1::int * interval '1 millisecond')
      `,
      [CLAIM_LEASE_MS, MAX_ATTEMPTS]
    );
    if (result.rowCount) this.deps.logger.warn({ recovered: result.rowCount }, "Recovered mail outbox claims of a stopped process");
  }

  /** Deletes finished rows past retention, in bounded batches. True when none is left. */
  private async purgeFinished(): Promise<boolean> {
    for (let batch = 0; batch < PURGE_MAX_BATCHES; batch++) {
      if ((await this.purgeBatch()) < PURGE_BATCH) return true;
    }
    return false;
  }

  private async purgeBatch(): Promise<number> {
    const result = await this.deps.db.query(
      `
        DELETE FROM email_outbox
        WHERE (tenant_id, email_id) IN (
          SELECT tenant_id, email_id FROM email_outbox
          WHERE status IN ('sent', 'failed', 'expired') AND updated_at < now() - ($1::bigint * interval '1 millisecond')
          LIMIT $2
        )
      `,
      [RETENTION_MS, PURGE_BATCH]
    );
    return result.rowCount ?? 0;
  }
}
