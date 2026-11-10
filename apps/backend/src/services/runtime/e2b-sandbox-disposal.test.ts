import { describe, expect, it, vi } from "vitest";

import { E2bSandboxDisposal } from "./e2b-sandbox-disposal.js";
import type { E2bRequestLimits } from "./e2b-sandbox.js";

type KillOptions = { apiKey: string } & E2bRequestLimits;
const target = { tenantId: "tenant-a", sessionId: "sess-1", sandboxId: "sbx-1" };

function makeDisposal(
  kill: (sandboxId: string, options: KillOptions) => Promise<boolean>,
  overrides: { requestTimeoutMs?: number; deadlineMs?: number; loader?: () => Promise<unknown> } = {}
) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const killSpy = vi.fn(kill);
  // Only the kill: a connect or a create would throw, so a test that passes made neither.
  const loadSandboxClass = vi.fn(overrides.loader ?? (async () => ({ kill: killSpy })));
  const disposal = new E2bSandboxDisposal({
    apiKey: "e2b-key",
    requestTimeoutMs: overrides.requestTimeoutMs ?? 5_000,
    deadlineMs: overrides.deadlineMs ?? 20_000,
    logger,
    loadSandboxClass: loadSandboxClass as never,
    retryBackoffMs: [0, 0, 0]
  });
  return { disposal, kill: killSpy, logger, loadSandboxClass };
}

describe("E2bSandboxDisposal", () => {
  it("kills the sandbox by id at the provider, with a time limit and a signal, and logs it", async () => {
    const { disposal, kill, logger } = makeDisposal(async () => true);

    await expect(disposal.destroy(target)).resolves.toBe("killed");

    expect(kill).toHaveBeenCalledExactlyOnceWith("sbx-1", {
      apiKey: "e2b-key", requestTimeoutMs: 5_000, signal: expect.any(AbortSignal)
    });
    expect(logger.info).toHaveBeenCalledWith(
      { sessionId: "sess-1", sandboxId: "sbx-1", outcome: "killed" }, expect.any(String));
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("counts a sandbox that the provider no longer has as done, and does not try again", async () => {
    const { disposal, kill, logger } = makeDisposal(async () => false);

    await expect(disposal.destroy(target)).resolves.toBe("not_found");

    expect(kill).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith(
      { sessionId: "sess-1", sandboxId: "sbx-1", outcome: "not_found" }, expect.any(String));
  });

  it("tries again after a failed kill", async () => {
    const { disposal, kill } = makeDisposal(vi.fn<(id: string, o: KillOptions) => Promise<boolean>>()
      .mockRejectedValueOnce(Object.assign(new Error("stub"), { statusCode: 500 }))
      .mockResolvedValueOnce(true));

    await expect(disposal.destroy(target)).resolves.toBe("killed");
    expect(kill).toHaveBeenCalledTimes(2);
  });

  it("reports a kill that failed every try, logs it as an error with the sandbox, and does not throw", async () => {
    const failure = Object.assign(new Error("stub"), { statusCode: 500 });
    const { disposal, kill, logger } = makeDisposal(async () => { throw failure; });

    await expect(disposal.destroy(target)).resolves.toBe("failed");

    expect(kill).toHaveBeenCalledTimes(4);
    expect(logger.error).toHaveBeenCalledWith(
      { err: failure, sessionId: "sess-1", sandboxId: "sbx-1", tries: 4 },
      expect.stringContaining("runs until the provider expires it"));
  });

  it("gives up a request that does not answer at the request timeout, and starts no try after the deadline", async () => {
    const signals: AbortSignal[] = [];
    const { disposal, kill } = makeDisposal(
      (_id, options) => { signals.push(options.signal!); return new Promise<boolean>(() => {}); },
      { requestTimeoutMs: 40, deadlineMs: 100 });
    const startedAt = Date.now();

    await expect(disposal.destroy(target)).resolves.toBe("failed");

    // Each try ends at the request timeout, and the last one at the deadline.
    expect(Date.now() - startedAt).toBeLessThan(400);
    expect(kill.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(kill.mock.calls.length).toBeLessThanOrEqual(4);
    // The SDK gets the time that is left, never more than the request timeout.
    for (const [, options] of kill.mock.calls) expect(options.requestTimeoutMs).toBeLessThanOrEqual(40);
    // A request that was given up is cancelled, with the SDK retries behind it.
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("counts an SDK that cannot be loaded as a failed try", async () => {
    const { disposal, kill, logger } = makeDisposal(async () => true, {
      loader: async () => { throw new Error("module not found"); }
    });

    await expect(disposal.destroy(target)).resolves.toBe("failed");
    expect(kill).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledOnce();
  });
});
