import { expect, test } from "vitest";

import type { Pool } from "../../lib/db.js";
import { createTestConfig } from "../../test-helpers/test-config.js";
import { buildMailWorker } from "./build-mail.js";

const logger = { info: () => {}, warn: () => {}, error: () => {} };
const db = {} as Pool;
const MAIL = { SMTP_URL: "smtps://smtp.example.test", MAIL_FROM: "no-reply@example.test" };

function senderOf(worker: ReturnType<typeof buildMailWorker>): unknown {
  return (worker as unknown as { deps: { sender: unknown } }).deps.sender;
}

test("a worker runs in jwt mode for every login type; it has a sender only with SMTP settings", () => {
  // dev-headers mode has no email.
  expect(buildMailWorker(createTestConfig(), db, logger)).toBeNull();

  for (const loginTypes of [["local"], ["workos"]] as const) {
    const cleanupOnly = buildMailWorker(createTestConfig({ AUTH_MODE: "jwt", AUTH_LOGIN_TYPES: loginTypes }), db, logger);
    expect(cleanupOnly, loginTypes[0]).not.toBeNull();
    expect(senderOf(cleanupOnly), loginTypes[0]).toBeNull();

    // WorkOS owners get the notice of a data setting change.
    const sending = buildMailWorker(createTestConfig({ AUTH_MODE: "jwt", AUTH_LOGIN_TYPES: loginTypes, ...MAIL }), db, logger);
    expect(senderOf(sending), loginTypes[0]).not.toBeNull();
    sending?.close();
  }
});
