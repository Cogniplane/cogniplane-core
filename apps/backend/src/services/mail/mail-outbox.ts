import type { PoolClient } from "pg";

import { decrypt, encrypt } from "../../lib/crypto-utils.js";
import { uuidv7 } from "../../lib/uuid.js";
import type { OutgoingMail } from "./mail-sender.js";
import { type LinkEmailVariant, renderLinkEmail } from "./link-emails.js";
import { renderSecurityNotice, type SecurityNotice } from "./security-notices.js";
import {
  addChange,
  type DataSettingChange,
  type NoticeChange,
  type NoticeDigest,
  OWNER_NOTICE_WINDOW_MINUTES,
  renderSettingChangeNotice,
  type SettingChangeNoticeContext
} from "./setting-change-notices.js";

// Writes a message into email_outbox, inside the caller's transaction. So
// the message exists if and only if the change it reports commits; the
// worker (mail-outbox-worker.ts) sends it after that. The message is
// encrypted until it is sent. A row belongs to a member of the tenant
// (migration 082): a local account, or a WorkOS owner for the notice of a
// data setting change. See docs/ARCHITECTURE.md, "Authentication".

/** A notice that is still not sent after this is dropped: it is no longer news. */
export const NOTICE_TTL_MS = 72 * 60 * 60_000;

/** One owner notice of data setting changes per owner in this time. */
export const OWNER_NOTICE_WINDOW_MS = OWNER_NOTICE_WINDOW_MINUTES * 60_000;

/**
 * The encrypted message of a row. An owner notice also keeps its list of
 * changes, so that a later change of the window can extend it. The sender
 * reads only the mail fields.
 */
type StoredMail = OutgoingMail & { notice?: NoticeDigest };

export type OutboxKind = SecurityNotice["kind"] | "tenant_setting_changed" | "password_reset_link" | "account_setup_link";

/** What the account services need: queue a notice in their transaction. */
export interface SecurityNoticeQueue {
  queue(client: PoolClient, tenantId: string, userId: string, notice: SecurityNotice): Promise<void>;
}

/**
 * What a data route needs: queue the owner notice of a data setting change in
 * the change's transaction (services/data-route-control.ts).
 */
export interface OwnerNoticeQueue {
  /** Queues one notice to each owner of the tenant with an address. Returns how many it queued. */
  queueOwnerNotice(client: PoolClient, tenantId: string, input: { actorUserId: string; change: DataSettingChange }): Promise<number>;
}

/** A one-time link to send, in the transaction that issued it. */
export type LinkMail = {
  kind: "password_reset_link" | "account_setup_link";
  /** Which text: who asked for the link, and what already happened. */
  variant: LinkEmailVariant;
  url: string;
  expiresAt: Date;
  /** The link's token hash: the worker sends the email only while this link still works. */
  tokenHash: string;
};

/** Notices and links: what the account service needs. */
export interface AccountMailQueue extends SecurityNoticeQueue {
  /** Queues the link email; returns the address it goes to, or null when the account has none. */
  queueLink(client: PoolClient, tenantId: string, userId: string, link: LinkMail): Promise<string | null>;
  /** A link email of one of these kinds was queued for the account within the last `withinMs`. */
  linkQueuedWithin(client: PoolClient, tenantId: string, userId: string, kinds: readonly LinkMail["kind"][], withinMs: number): Promise<boolean>;
}

export function encryptMail(mail: OutgoingMail, secret: string): string {
  return encrypt(JSON.stringify(mail), secret);
}

export class MailOutbox implements AccountMailQueue, OwnerNoticeQueue {
  constructor(private readonly deps: { secret: string; now?: () => number }) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * Queues a security notice to the account's address. Reads the address,
   * the name, and the organization in the caller's transaction, after its
   * identity lock. An account without an address gets nothing.
   */
  async queue(client: PoolClient, tenantId: string, userId: string, notice: SecurityNotice): Promise<void> {
    const row = await this.recipient(client, tenantId, userId);
    if (!row) return;
    const now = this.now();
    const mail = renderSecurityNotice(notice, {
      to: row.email,
      displayName: row.display_name,
      organization: row.tenant_name,
      at: new Date(now)
    });
    await this.insert(client, { tenantId, userId, kind: notice.kind, mail, expiresAt: new Date(now + NOTICE_TTL_MS) });
  }

  /**
   * Queues the notice of a data setting change to every owner of the tenant
   * with an address: local and WorkOS owners alike, and the actor too when
   * the actor is an owner (a stolen owner session is the case to report).
   * Reads the owners and the actor in the caller's transaction, under RLS.
   * Returns how many owners the notice reaches (0: no owner has an address).
   *
   * One notice per owner per window (OWNER_NOTICE_WINDOW_MS), so a loop of
   * changes cannot flood the outbox that every tenant's email shares. The
   * window of a notice starts when it is sent: its `sent_at`, or, while it
   * is not sent, the time it becomes due (`GREATEST(created_at,
   * next_attempt_at)`). So two notices never go out less than one window
   * apart.
   * - A notice that waits for its first send attempt and has not expired
   *   gets the change added to its list (setting-change-notices.ts: at most
   *   OWNER_NOTICE_MAX_CHANGES, then "and other changes"). A notice whose
   *   send failed, or that expired, gets no change: it can fail again or
   *   never go out.
   * - Otherwise, when a notice's window is still open, the change goes into
   *   one follow-up notice that waits until that window ends. Later changes
   *   are added to the follow-up, so no change is lost.
   * - Otherwise a new notice goes out at once.
   * A lock per tenant makes concurrent changes take these steps one at a
   * time.
   */
  async queueOwnerNotice(
    client: PoolClient,
    tenantId: string,
    input: { actorUserId: string; change: DataSettingChange }
  ): Promise<number> {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('owner_notice:' || $1, 0))`, [tenantId]);
    const owners = await client.query<{ user_id: string; email: string | null; tenant_name: string }>(
      `
        SELECT tm.user_id, u.email, t.tenant_name
        FROM tenant_memberships tm
        JOIN users u ON u.user_id = tm.user_id
        JOIN tenants t ON t.tenant_id = tm.tenant_id
        WHERE tm.tenant_id = $1 AND tm.role = 'owner'
        ORDER BY tm.user_id
      `,
      [tenantId]
    );
    const actor = await client.query<{ email: string | null; display_name: string | null }>(
      `SELECT u.email, u.display_name FROM users u WHERE u.user_id = $1`,
      [input.actorUserId]
    );
    const now = this.now();
    const item: NoticeChange = {
      change: input.change,
      actor: { displayName: actor.rows[0]?.display_name ?? null, email: actor.rows[0]?.email ?? null },
      at: new Date(now).toISOString()
    };
    let reached = 0;
    for (const owner of owners.rows) {
      if (!owner.email) continue;
      reached += 1;
      const context = { to: owner.email, organization: { name: owner.tenant_name, id: tenantId } };
      // The notice of this owner that can take the change, if there is one,
      // else the notice whose window ends last.
      const recent = await client.query<{ email_id: string; extendable: boolean; window_start: Date; message_encrypted: string | null }>(
        `
          SELECT email_id, message_encrypted, window_start,
                 (status = 'queued' AND attempts = 0 AND expires_at > clock_timestamp()) AS extendable
          FROM (
            -- The lock keeps the worker from claiming a notice while a
            -- change is added to it (the worker skips locked rows).
            SELECT email_id, message_encrypted, status, attempts, expires_at,
                   COALESCE(sent_at, GREATEST(created_at, next_attempt_at)) AS window_start
            FROM email_outbox
            WHERE tenant_id = $1 AND user_id = $2 AND kind = 'tenant_setting_changed'
              AND (status = 'queued'
                OR COALESCE(sent_at, GREATEST(created_at, next_attempt_at)) > clock_timestamp() - ($3::int * interval '1 millisecond'))
            FOR UPDATE
          ) notices
          ORDER BY extendable DESC, window_start DESC
          LIMIT 1
        `,
        [tenantId, owner.user_id, OWNER_NOTICE_WINDOW_MS]
      );
      const row = recent.rows[0];
      if (row?.extendable) {
        const digest = addChange(this.digestOf(row.message_encrypted), item);
        await client.query(
          `UPDATE email_outbox SET message_encrypted = $3, updated_at = now() WHERE tenant_id = $1 AND email_id = $2 AND status = 'queued'`,
          [tenantId, row.email_id, encryptMail(this.noticeMail(digest, context), this.deps.secret)]
        );
        continue;
      }
      await this.insert(client, {
        tenantId,
        userId: owner.user_id,
        kind: "tenant_setting_changed",
        mail: this.noticeMail(addChange(null, item), context),
        expiresAt: new Date(now + NOTICE_TTL_MS),
        // A notice of an open window: wait until that window ends.
        sendAfter: row ? new Date(row.window_start.getTime() + OWNER_NOTICE_WINDOW_MS) : undefined
      });
    }
    return reached;
  }

  /** The rendered notice with its list of changes, which a later change of the window extends. */
  private noticeMail(digest: NoticeDigest, context: SettingChangeNoticeContext): StoredMail {
    return { ...renderSettingChangeNotice(digest, context), notice: digest };
  }

  /** The list of a queued notice. A message that cannot be read gives an empty list marked "more". */
  private digestOf(messageEncrypted: string | null): NoticeDigest {
    try {
      const stored = JSON.parse(decrypt(messageEncrypted ?? "", this.deps.secret)) as StoredMail;
      if (stored.notice && Array.isArray(stored.notice.changes)) return stored.notice;
    } catch {
      // Falls through.
    }
    return { changes: [], more: true };
  }

  /**
   * Queues the email that carries a link, with the link's expiry: a message
   * whose link no longer works is not sent. The message is encrypted like
   * every other; it holds the raw token. Returns the address, or null when
   * the account has none.
   */
  async queueLink(client: PoolClient, tenantId: string, userId: string, link: LinkMail): Promise<string | null> {
    const row = await this.recipient(client, tenantId, userId);
    if (!row) return null;
    const mail = renderLinkEmail(link.variant, {
      to: row.email,
      displayName: row.display_name,
      organization: row.tenant_name,
      at: new Date(this.now()),
      url: link.url,
      expiresAt: link.expiresAt
    });
    await this.insert(client, { tenantId, userId, kind: link.kind, mail, expiresAt: link.expiresAt, tokenHash: link.tokenHash });
    return row.email;
  }

  async linkQueuedWithin(
    client: PoolClient, tenantId: string, userId: string, kinds: readonly LinkMail["kind"][], withinMs: number
  ): Promise<boolean> {
    const result = await client.query(
      `
        SELECT 1 FROM email_outbox
        WHERE tenant_id = $1 AND user_id = $2 AND kind = ANY($3::text[])
          AND created_at > clock_timestamp() - ($4::int * interval '1 millisecond')
        LIMIT 1
      `,
      [tenantId, userId, [...kinds], withinMs]
    );
    return (result.rowCount ?? 0) > 0;
  }

  private async recipient(client: PoolClient, tenantId: string, userId: string) {
    const found = await client.query<{ email: string | null; display_name: string | null; tenant_name: string }>(
      `
        SELECT u.email, u.display_name, t.tenant_name
        FROM local_identities li
        JOIN users u ON u.user_id = li.user_id
        JOIN tenants t ON t.tenant_id = li.tenant_id
        WHERE li.tenant_id = $1 AND li.user_id = $2
      `,
      [tenantId, userId]
    );
    const row = found.rows[0];
    return row?.email ? { ...row, email: row.email } : null;
  }

  private async insert(
    client: PoolClient,
    input: {
      tenantId: string; userId: string; kind: OutboxKind; mail: OutgoingMail; expiresAt: Date; tokenHash?: string;
      /** The worker sends it at this time, not before. Default: at once. */
      sendAfter?: Date;
    }
  ): Promise<string> {
    const emailId = uuidv7();
    // created_at is the time of this statement, not of the transaction's
    // start: a transaction that waited for the identity lock must not date
    // its email earlier, or the cooldown would end early.
    await client.query(
      `
        INSERT INTO email_outbox (tenant_id, email_id, user_id, kind, message_encrypted, expires_at, token_hash, created_at, next_attempt_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, clock_timestamp(), COALESCE($8::timestamptz, clock_timestamp()))
      `,
      [
        input.tenantId, emailId, input.userId, input.kind, encryptMail(input.mail, this.deps.secret), input.expiresAt,
        input.tokenHash ?? null, input.sendAfter ?? null
      ]
    );
    return emailId;
  }
}
