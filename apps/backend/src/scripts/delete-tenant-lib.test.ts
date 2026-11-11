import { describe, expect, test, vi } from "vitest";

import { parseDeleteTenantArguments, runDeleteTenant } from "./delete-tenant-lib.js";

const complete = [
  "--tenant-id", "t1",
  "--confirm", "t1",
  "--request-id", "OPS-42",
  "--third-party-disposition", "No third-party data.",
  "--backup-disposition", "Backups expire in 30 days.",
  "--maintenance-confirmed"
];
const MAINTENANCE_ERROR =
  "--maintenance-confirmed is required after the backend has stopped gracefully and database writes are quiesced.";

/** `complete` with the value after `flag` replaced. */
function withValue(flag: string, value: string): string[] {
  return complete.map((word, i) => (complete[i - 1] === flag ? value : word));
}

/** `complete` without `flag` and its value. */
function without(flag: string): string[] {
  const at = complete.indexOf(flag);
  return complete.filter((_, i) => i !== at && i !== at + 1);
}

describe("parseDeleteTenantArguments", () => {
  test("returns the request when every flag is present and confirmed", () => {
    const expected = {
      tenantId: "t1",
      requestId: "OPS-42",
      thirdPartyDisposition: "No third-party data.",
      backupDisposition: "Backups expire in 30 days.",
      flushRedis: false
    };

    expect(parseDeleteTenantArguments(complete)).toEqual(expected);
    // The bare flag can come anywhere.
    expect(parseDeleteTenantArguments(["--maintenance-confirmed", ...complete.slice(0, -1)])).toEqual(expected);
  });

  test("flushes Redis only when --flush-redis is given", () => {
    expect(parseDeleteTenantArguments(complete).flushRedis).toBe(false);
    expect(parseDeleteTenantArguments([...complete, "--flush-redis"]).flushRedis).toBe(true);
    expect(parseDeleteTenantArguments(["--flush-redis", ...complete]).flushRedis).toBe(true);
  });

  test("refuses a confirmation that does not repeat the tenant id, before it checks maintenance", () => {
    const mismatched = withValue("--confirm", "t2");

    expect(() => parseDeleteTenantArguments(mismatched)).toThrow("--confirm must exactly match --tenant-id.");
    expect(() => parseDeleteTenantArguments(mismatched.slice(0, -1))).toThrow("--confirm must exactly match --tenant-id.");
  });

  test("refuses to run until the operator confirms maintenance", () => {
    expect(() => parseDeleteTenantArguments(complete.slice(0, -1))).toThrow(MAINTENANCE_ERROR);
  });

  // Each case can be rejected by one check only, so removing that check fails it.
  test.each([
    ["a required flag is missing", without("--request-id")],
    ["the last flag has no value", [...without("--request-id"), "--request-id"]],
    ["a value is empty", withValue("--backup-disposition", "")],
    ["a value is another flag", withValue("--backup-disposition", "--maintenance-confirmed")],
    ["a word is not a flag", ["stray", "word", ...complete]],
    ["a flag is unknown", [...complete, "--dry-run", "yes"]],
    ["a flag is repeated", [...complete, "--tenant-id", "t1"]],
    ["the maintenance flag is repeated", [...complete, "--maintenance-confirmed"]],
    ["the flush flag is repeated", [...complete, "--flush-redis", "--flush-redis"]],
    ["the flush flag has a value", [...complete, "--flush-redis", "yes"]],
    ["the flush flag has an inline value", [...complete, "--flush-redis=yes"]],
    // pnpm passes a literal "--" on to the script.
    ["the arguments start with --", ["--", ...complete]]
  ])("prints usage when %s", (_case, argv) => {
    expect(() => parseDeleteTenantArguments(argv)).toThrow(/^Usage: delete-tenant/);
  });
});

describe("runDeleteTenant", () => {
  // The refusal comes before the command opens the database or Redis, so this
  // test needs neither. The integration suite shows that the tenant stays.
  test("refuses --flush-redis when REDIS_URL is not configured", async () => {
    const connectRedis = vi.fn();
    const print = vi.fn();

    await expect(runDeleteTenant([...complete, "--flush-redis"], {
      MIGRATION_DATABASE_URL: "postgres://unused@127.0.0.1:1/unused"
    }, { connectRedis, print })).rejects.toThrow(
      "--flush-redis needs REDIS_URL, but REDIS_URL is not configured. Nothing was deleted."
    );
    expect(connectRedis).not.toHaveBeenCalled();
    expect(print).not.toHaveBeenCalled();
  });
});
