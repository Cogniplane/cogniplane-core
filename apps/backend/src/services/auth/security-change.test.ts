import { describe, expect, test, vi } from "vitest";

import type { Pool } from "../../lib/db.js";
import type { SandboxDisposalOutcome } from "../runtime/e2b-sandbox-disposal.js";
import type { ReleasedAccountSandbox } from "../session-execution-store.js";
import { type ChangedAccounts, operatorSecurityChange, requestSecurityVersion, stopActiveWork, withSecurityChange } from "./security-change.js";

/**
 * A pool whose one client records every statement, and the after-commit calls in the same
 * list. The statements of the sandbox release (releaseAccountSandboxes) are recorded by
 * their step, and the last one returns `taken`.
 */
function recordingPool(options: { failOn?: string; taken?: Array<Record<string, string>> } = {}) {
  const log: string[] = [];
  const client = {
    async query(text: string) {
      log.push(text.startsWith("SELECT set_config") ? "SET TENANT" : releaseStep(text) ?? text);
      if (options.failOn && text === options.failOn) throw new Error(`${text} failed`);
      if (releaseStep(text) === "take sandboxes") return { rows: options.taken ?? [], rowCount: options.taken?.length ?? 0 };
      return { rows: [], rowCount: 0 };
    },
    release() {}
  };
  return { pool: { connect: async () => client } as unknown as Pool, log };
}

function releaseStep(text: string): string | undefined {
  if (!text.includes("FROM sessions") && !text.includes("UPDATE sessions") && !text.includes("UPDATE session_executions")) return undefined;
  if (text.includes("UPDATE session_executions")) return "stop leases";
  if (text.includes("UPDATE sessions")) return "take sandboxes";
  return text.includes("FOR UPDATE") ? "lock chats" : undefined;
}

const RELEASE_STEPS = ["lock chats", "stop leases", "take sandboxes"];

describe("withSecurityChange", () => {
  test("calls the after-commit handler once, after COMMIT, with each changed account once", async () => {
    const { pool, log } = recordingPool();
    const after = vi.fn(async (changed: ChangedAccounts) => {
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
    expect(log).toEqual(["BEGIN", "SET TENANT", "UPDATE local_identities", ...RELEASE_STEPS, "COMMIT", "after tenant-1 user-1,user-2"]);
    expect(after).toHaveBeenCalledTimes(1);
  });

  test("takes the sandboxes of the changed accounts in the transaction, and gives them to the handler after COMMIT", async () => {
    const { pool, log } = recordingPool({
      taken: [{ user_id: "user-1", session_id: "session-a", sandbox_id: "sandbox-a" }]
    });
    const after = vi.fn(async (_changed: ChangedAccounts) => { log.push("after"); });

    await withSecurityChange(pool, "tenant-1", after, async (_client, change) => {
      change.endActiveWork("user-1");
    });

    expect(log.slice(-5)).toEqual([...RELEASE_STEPS, "COMMIT", "after"]);
    expect(after).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      userIds: ["user-1"],
      releasedSandboxes: [{ tenantId: "tenant-1", userId: "user-1", sessionId: "session-a", sandboxId: "sandbox-a" }]
    });
  });

  test("calls nothing, and takes no sandbox, when the transaction changed no account", async () => {
    const { pool, log } = recordingPool();
    const after = vi.fn(async () => {});
    await withSecurityChange(pool, "tenant-1", after, async () => "unchanged");
    expect(after).not.toHaveBeenCalled();
    expect(log).toEqual(["BEGIN", "SET TENANT", "COMMIT"]);
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
  const logger = () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() });
  /** Runs every task that is already queued; the fakes below do no I/O. */
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  /** A provider that this test does not reach: these accounts saved no sandbox. */
  const noKill = () => vi.fn(async (): Promise<SandboxDisposalOutcome> => { throw new Error("no sandbox to kill"); });
  const sandbox = (userId: string, sessionId: string): ReleasedAccountSandbox =>
    ({ tenantId: "tenant-1", userId, sessionId, sandboxId: `sandbox-${sessionId}` });

  test("stops the runtimes of each account in this process", async () => {
    const invalidateRuntimesForUser = vi.fn(async (_tenantId: string, userId: string) => userId === "user-1" ? ["session-a", "session-b"] : []);
    const log = logger();
    await stopActiveWork({ runtimes: { invalidateRuntimesForUser, destroySandbox: noKill() }, logger: log })({
      tenantId: "tenant-1", userIds: ["user-1", "user-2"], releasedSandboxes: []
    });
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
    void stopActiveWork({ runtimes: { invalidateRuntimesForUser, destroySandbox: noKill() }, logger: log })({
      tenantId: "tenant-1", userIds: ["user-1", "user-2"], releasedSandboxes: []
    }).then(() => { returned = true; });
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
    await expect(stopActiveWork({ runtimes: { invalidateRuntimesForUser, destroySandbox: noKill() }, logger: log })({
      tenantId: "tenant-1", userIds: ["user-1", "user-2"], releasedSandboxes: []
    })).resolves.toBeUndefined();
    expect(invalidateRuntimesForUser).toHaveBeenCalledWith("tenant-1", "user-2", { reason: "security_change" });

    // A failure after the handler returned is logged; nothing rejects unhandled.
    failDisposal(failure);
    await settle();
    expect(log.error).toHaveBeenCalledWith({ err: failure, tenantId: "tenant-1", userId: "user-1" }, expect.stringContaining("failed to stop"));
    expect(log.info).toHaveBeenCalledWith({ tenantId: "tenant-1", userId: "user-2", sessionIds: ["session-c"] }, expect.any(String));
  });

  test("kills each sandbox that the change took, after the account's turns in this process stopped, and does not wait for the kills", async () => {
    const order: string[] = [];
    const invalidateRuntimesForUser = vi.fn((_tenantId: string, userId: string) => {
      // The adapter aborts the turns here, before its first await.
      order.push(`stop ${userId}`);
      return new Promise<string[]>(() => {});
    });
    let finishKill!: (outcome: SandboxDisposalOutcome) => void;
    const destroySandbox = vi.fn((input: { sandboxId: string }) => {
      order.push(`kill ${input.sandboxId}`);
      return new Promise<SandboxDisposalOutcome>((resolve) => { finishKill = resolve; });
    });
    const log = logger();

    let returned = false;
    void stopActiveWork({ runtimes: { invalidateRuntimesForUser, destroySandbox }, logger: log })({
      tenantId: "tenant-1", userIds: ["user-1"], releasedSandboxes: [sandbox("user-1", "a")]
    }).then(() => { returned = true; });
    await settle();

    expect(order).toEqual(["stop user-1", "kill sandbox-a"]);
    // Only the id goes to the provider; the account is for the log.
    expect(destroySandbox).toHaveBeenCalledExactlyOnceWith({ tenantId: "tenant-1", sessionId: "a", sandboxId: "sandbox-a" });
    expect(returned).toBe(true);
    expect(log.info).not.toHaveBeenCalled();

    finishKill("killed");
    await settle();
    expect(log.info).toHaveBeenCalledWith(
      { tenantId: "tenant-1", userId: "user-1", sessionId: "a", sandboxId: "sandbox-a", outcome: "killed" }, expect.any(String)
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  test("a kill that fails, throws or is not sent is logged with its sandbox, and the other kills go on", async () => {
    const failure = new Error("provider unreachable");
    const outcomes: Record<string, () => Promise<SandboxDisposalOutcome>> = {
      "sandbox-a": async () => "failed",
      "sandbox-b": async () => { throw failure; },
      "sandbox-c": async () => "skipped",
      "sandbox-d": async () => "not_found"
    };
    const destroySandbox = vi.fn((input: { sandboxId: string }) => outcomes[input.sandboxId]!());
    const log = logger();

    await expect(stopActiveWork({ runtimes: { invalidateRuntimesForUser: async () => [], destroySandbox }, logger: log })({
      tenantId: "tenant-1", userIds: ["user-1", "user-2"],
      releasedSandboxes: [sandbox("user-1", "a"), sandbox("user-1", "b"), sandbox("user-2", "c"), sandbox("user-2", "d")]
    })).resolves.toBeUndefined();
    await settle();

    expect(destroySandbox).toHaveBeenCalledTimes(4);
    const notKilled = expect.stringContaining("runs until the provider expires it");
    expect(log.error).toHaveBeenCalledWith(
      { tenantId: "tenant-1", userId: "user-1", sessionId: "a", sandboxId: "sandbox-a", outcome: "failed" }, notKilled);
    expect(log.error).toHaveBeenCalledWith(
      { err: failure, tenantId: "tenant-1", userId: "user-1", sessionId: "b", sandboxId: "sandbox-b" }, notKilled);
    expect(log.warn).toHaveBeenCalledWith(
      { tenantId: "tenant-1", userId: "user-2", sessionId: "c", sandboxId: "sandbox-c", outcome: "skipped" }, notKilled);
    expect(log.info).toHaveBeenCalledWith(
      { tenantId: "tenant-1", userId: "user-2", sessionId: "d", sandboxId: "sandbox-d", outcome: "not_found" }, expect.any(String));
    expect(log.error).toHaveBeenCalledTimes(2);
  });

  test("a change that took no sandbox sends no kill and logs nothing about sandboxes", async () => {
    const destroySandbox = noKill();
    const log = logger();
    await stopActiveWork({ runtimes: { invalidateRuntimesForUser: async () => ["session-a"], destroySandbox }, logger: log })({
      tenantId: "tenant-1", userIds: ["user-1"], releasedSandboxes: []
    });
    await settle();
    expect(destroySandbox).not.toHaveBeenCalled();
    const logged = [...log.info.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls];
    expect(logged).toEqual([[{ tenantId: "tenant-1", userId: "user-1", sessionIds: ["session-a"] }, expect.any(String)]]);
  });
});

describe("operatorSecurityChange", () => {
  const released = (sessionId: string): ReleasedAccountSandbox =>
    ({ tenantId: "tenant-1", userId: "owner-1", sessionId, sandboxId: `sandbox-${sessionId}` });
  const logger = () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() });

  test("waits for the kill of each sandbox that the change took", async () => {
    let finishKill!: () => void;
    const destroySandbox = vi.fn(() => new Promise<SandboxDisposalOutcome>((resolve) => { finishKill = () => resolve("killed"); }));
    const log = logger();
    let returned = false;
    const handled = operatorSecurityChange({ sandboxes: { destroySandbox }, logger: log })({
      tenantId: "tenant-1", userIds: ["owner-1"], releasedSandboxes: [released("a")]
    }).then(() => { returned = true; });
    await new Promise((resolve) => setImmediate(resolve));
    // The command process ends after the handler: it must not return before the kill.
    expect(returned).toBe(false);
    finishKill();
    await handled;
    expect(destroySandbox).toHaveBeenCalledExactlyOnceWith({ tenantId: "tenant-1", sessionId: "a", sandboxId: "sandbox-a" });
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ sandboxId: "sandbox-a", outcome: "killed" }), expect.any(String));
  });

  test("with no E2B configuration it kills nothing and names each sandbox that runs on", async () => {
    const log = logger();
    await operatorSecurityChange({ sandboxes: null, logger: log })({
      tenantId: "tenant-1", userIds: ["owner-1"], releasedSandboxes: [released("a"), released("b")]
    });
    expect(log.warn.mock.calls.map(([fields]) => (fields as { sandboxId: string }).sandboxId)).toEqual(["sandbox-a", "sandbox-b"]);
    expect(log.info).not.toHaveBeenCalled();
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
