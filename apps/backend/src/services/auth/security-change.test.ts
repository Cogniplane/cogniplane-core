import { describe, expect, test, vi } from "vitest";

import type { Pool } from "../../lib/db.js";
import { requestSecurityVersion, stopActiveWork, withSecurityChange } from "./security-change.js";

/** A pool whose one client records every statement, and the after-commit calls in the same list. */
function recordingPool(options: { failOn?: string } = {}) {
  const log: string[] = [];
  const client = {
    async query(text: string) {
      log.push(text.startsWith("SELECT set_config") ? "SET TENANT" : text);
      if (options.failOn && text === options.failOn) throw new Error(`${text} failed`);
      return { rows: [], rowCount: 0 };
    },
    release() {}
  };
  return { pool: { connect: async () => client } as unknown as Pool, log };
}

describe("withSecurityChange", () => {
  test("calls the after-commit handler once, after COMMIT, with each changed account once", async () => {
    const { pool, log } = recordingPool();
    const after = vi.fn(async (changed: { tenantId: string; userIds: string[] }) => {
      log.push(`after ${changed.tenantId} ${changed.userIds.join(",")}`);
    });

    const result = await withSecurityChange(pool, "tenant-1", after, async (client, change) => {
      await client.query("UPDATE local_identities");
      change.endActiveWork("user-1");
      change.endActiveWork("user-2");
      change.endActiveWork("user-1");
      return "done";
    });

    expect(result).toBe("done");
    expect(log).toEqual(["BEGIN", "SET TENANT", "UPDATE local_identities", "COMMIT", "after tenant-1 user-1,user-2"]);
    expect(after).toHaveBeenCalledTimes(1);
  });

  test("calls nothing when the transaction changed no account", async () => {
    const { pool } = recordingPool();
    const after = vi.fn(async () => {});
    await withSecurityChange(pool, "tenant-1", after, async () => "unchanged");
    expect(after).not.toHaveBeenCalled();
  });

  test("calls nothing when the transaction rolls back after a change", async () => {
    const { pool, log } = recordingPool();
    const after = vi.fn(async () => {});
    await expect(withSecurityChange(pool, "tenant-1", after, async (_client, change) => {
      change.endActiveWork("user-1");
      throw new Error("refused later in the transaction");
    })).rejects.toThrow("refused later in the transaction");
    expect(log.at(-1)).toBe("ROLLBACK");
    expect(after).not.toHaveBeenCalled();
  });

  test("a failing handler does not undo the change: the result comes back, and the failure is logged", async () => {
    const { pool, log } = recordingPool();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await withSecurityChange(pool, "tenant-1", async () => { throw new Error("replica unreachable"); },
        async (_client, change) => {
          change.endActiveWork("user-1");
          return "new session";
        });
      expect(result).toBe("new session");
      expect(log).toContain("COMMIT");
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(consoleError.mock.calls[0]![0]))).toEqual({
        level: "error",
        msg: "security change: the after-commit handler failed; the change stays",
        tenantId: "tenant-1",
        userIds: ["user-1"],
        err: "replica unreachable"
      });
    } finally {
      consoleError.mockRestore();
    }
  });

  test("calls nothing when the commit fails", async () => {
    const { pool } = recordingPool({ failOn: "COMMIT" });
    const after = vi.fn(async () => {});
    await expect(withSecurityChange(pool, "tenant-1", after, async (_client, change) => {
      change.endActiveWork("user-1");
    })).rejects.toThrow("COMMIT failed");
    expect(after).not.toHaveBeenCalled();
  });
});

describe("stopActiveWork", () => {
  const logger = () => ({ error: vi.fn(), info: vi.fn() });
  /** Runs every task that is already queued; the fakes below do no I/O. */
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  test("stops the runtimes of each account in this process", async () => {
    const invalidateRuntimesForUser = vi.fn(async (_tenantId: string, userId: string) => userId === "user-1" ? ["session-a", "session-b"] : []);
    const log = logger();
    await stopActiveWork({ runtimes: { invalidateRuntimesForUser }, logger: log })({ tenantId: "tenant-1", userIds: ["user-1", "user-2"] });
    await settle();
    // The reason reaches the running turn, so the user sees why it stopped.
    expect(invalidateRuntimesForUser.mock.calls).toEqual([
      ["tenant-1", "user-1", { reason: "security_change" }],
      ["tenant-1", "user-2", { reason: "security_change" }]
    ]);
    expect(log.info).toHaveBeenCalledWith({ tenantId: "tenant-1", userId: "user-1", sessionIds: ["session-a", "session-b"] }, expect.any(String));
    expect(log.error).not.toHaveBeenCalled();
  });

  test("starts the stop of each account at once, and does not wait for the runtimes to be disposed", async () => {
    let finishDisposal!: (sessionIds: string[]) => void;
    const disposal = new Promise<string[]>((resolve) => { finishDisposal = resolve; });
    const invalidateRuntimesForUser = vi.fn(() => disposal);
    const log = logger();

    let returned = false;
    void stopActiveWork({ runtimes: { invalidateRuntimesForUser }, logger: log })({ tenantId: "tenant-1", userIds: ["user-1", "user-2"] })
      .then(() => { returned = true; });
    // invalidateRuntimesForUser aborts the turns before its first await, so
    // the calls must be made before the handler returns.
    expect(invalidateRuntimesForUser).toHaveBeenCalledTimes(2);
    await settle();
    expect(returned).toBe(true);
    expect(log.info).not.toHaveBeenCalled();

    // The result is logged when the disposal ends.
    finishDisposal(["session-a"]);
    await settle();
    expect(log.info).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledWith({ tenantId: "tenant-1", userId: "user-1", sessionIds: ["session-a"] }, expect.any(String));
  });

  test("a failure is logged as an error, does not reject, and does not stop the other accounts", async () => {
    const failure = new Error("runtime did not stop");
    let failDisposal!: (error: Error) => void;
    const disposal = new Promise<string[]>((_resolve, reject) => { failDisposal = reject; });
    const invalidateRuntimesForUser = vi.fn(async (_tenantId: string, userId: string) => {
      if (userId === "user-1") return disposal;
      return ["session-c"];
    });
    const log = logger();
    await expect(stopActiveWork({ runtimes: { invalidateRuntimesForUser }, logger: log })({
      tenantId: "tenant-1", userIds: ["user-1", "user-2"]
    })).resolves.toBeUndefined();
    expect(invalidateRuntimesForUser).toHaveBeenCalledWith("tenant-1", "user-2", { reason: "security_change" });

    // A failure after the handler returned is logged; nothing rejects unhandled.
    failDisposal(failure);
    await settle();
    expect(log.error).toHaveBeenCalledWith({ err: failure, tenantId: "tenant-1", userId: "user-1" }, expect.stringContaining("failed to stop"));
    expect(log.info).toHaveBeenCalledWith({ tenantId: "tenant-1", userId: "user-2", sessionIds: ["session-c"] }, expect.any(String));
  });
});

describe("requestSecurityVersion", () => {
  const auth = { tenantId: "tenant-1", userId: "user-1" };

  test("takes the version from the session, and reads nothing", async () => {
    const readCurrent = vi.fn(async () => 9);
    expect(await requestSecurityVersion({ ...auth, session: { securityVersion: 4 } }, "jwt", readCurrent)).toBe(4);
    // A WorkOS session carries no version.
    expect(await requestSecurityVersion({ ...auth, session: {} }, "jwt", readCurrent)).toBeNull();
    expect(readCurrent).not.toHaveBeenCalled();
  });

  test("dev-headers has no session: the account's version now; jwt without a session: null", async () => {
    const readCurrent = vi.fn(async () => 9);
    expect(await requestSecurityVersion(auth, "dev-headers", readCurrent)).toBe(9);
    expect(readCurrent).toHaveBeenCalledWith("tenant-1", "user-1");
    expect(await requestSecurityVersion(auth, "jwt", readCurrent)).toBeNull();
    expect(readCurrent).toHaveBeenCalledTimes(1);
  });
});
