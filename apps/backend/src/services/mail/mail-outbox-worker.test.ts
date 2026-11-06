import { expect, test } from "vitest";

import type { Pool } from "../../lib/db.js";
import { encryptMail } from "./mail-outbox.js";
import { MailOutboxWorker } from "./mail-outbox-worker.js";
import type { MailSender, OutgoingMail } from "./mail-sender.js";

// The real SQL runs against Postgres in integration/mail-outbox.integration.test.ts.
// This test pauses the worker at one exact point, which a real database cannot.

const SECRET = "mail-outbox-worker-unit-secret-at-least-32-chars";
const logger = { info: () => {}, warn: () => {}, error: () => {} };

test("stop() during the check before a send hands the claim back and sends nothing", async () => {
  let openCheck!: () => void;
  const checkGate = new Promise<void>((resolve) => { openCheck = resolve; });
  const queries: string[] = [];
  const db = {
    query: async (sql: string) => {
      const text = sql.replace(/\s+/g, " ").trim();
      queries.push(text);
      if (text.startsWith("WITH waiting AS")) {
        const message = encryptMail({ to: "max@example.test", subject: "s", text: "t", html: "t" }, SECRET);
        return { rowCount: 1, rows: [{ tenant_id: "t1", email_id: "e1", kind: "password_changed", message_encrypted: message, attempts: 1 }] };
      }
      if (text.startsWith("SELECT (expires_at > now()")) {
        await checkGate;
        return { rowCount: 1, rows: [{ deliverable: true }] };
      }
      return { rowCount: 0, rows: [] };
    }
  } as unknown as Pool;
  const sent: OutgoingMail[] = [];
  const sender: MailSender = { send: async (mail) => { sent.push(mail); }, close: () => {} };
  const worker = new MailOutboxWorker({ db, sender, secret: SECRET, logger });

  const pass = worker.tick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  worker.stop();
  openCheck();
  await pass;

  expect(sent).toEqual([]);
  expect(queries.some((text) => text.startsWith("UPDATE email_outbox SET status = 'queued', attempts = attempts - 1"))).toBe(true);
});
