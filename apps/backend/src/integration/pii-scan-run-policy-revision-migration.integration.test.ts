// Migrations 077 and 078 add the pii_scan_runs.policy_revision check without
// a table read under the ACCESS EXCLUSIVE lock of ADD COLUMN. 077 adds the
// check NOT VALID. 078 validates it in its own transaction, with a lock that
// lets other sessions read and write the table.

import { describe, expect, test } from "vitest";

import { adminDatabaseUrl } from "./support/database.js";
import { withStagedDatabase } from "./support/staged-migrations.js";

const CHECK = "pii_scan_runs_policy_revision_check";

describe.skipIf(!adminDatabaseUrl())("pii_scan_runs.policy_revision migrations", () => {
  test("077 adds the check NOT VALID, and 078 validates it while a writer holds its table lock", async () => {
    await withStagedDatabase(async ({ db, migrate }) => {
      await migrate((file) => Number.parseInt(file, 10) <= 77);
      const validated = async () =>
        (await db.query("SELECT convalidated FROM pg_constraint WHERE conname = $1", [CHECK])).rows;
      expect(await validated()).toEqual([{ convalidated: false }]);

      // The writer holds ROW EXCLUSIVE on pii_scan_runs, as an open insert
      // does. VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE, which does
      // not conflict. A statement that needs ACCESS EXCLUSIVE would wait for
      // the runner's 10-second lock timeout and fail.
      const writer = await db.connect();
      try {
        await writer.query("BEGIN");
        await writer.query("LOCK TABLE pii_scan_runs IN ROW EXCLUSIVE MODE");
        await migrate((file) => Number.parseInt(file, 10) === 78);
      } finally {
        await writer.query("ROLLBACK");
        writer.release();
      }
      expect(await validated()).toEqual([{ convalidated: true }]);

      await expect(db.query(
        `INSERT INTO pii_scan_runs (tenant_id, scan_run_id, subject_type, subject_id, mode, policy_revision)
         VALUES ('t', 'r', 'artifact', 'a', 'detect', -1)`
      )).rejects.toThrow(CHECK);
    });
  });
});
