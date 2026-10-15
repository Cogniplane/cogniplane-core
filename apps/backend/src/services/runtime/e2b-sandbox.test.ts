import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ALL_TRAFFIC, Sandbox } from "e2b";

import { isSandboxGoneError } from "../deep-agents/deep-agents-e2b-backend.js";
import {
  loadE2bSandboxClass,
  toE2bCreateOptions,
  type E2bSandboxClassLike,
  type E2bSandboxLike
} from "./e2b-sandbox.js";
import {
  resolveSandboxNetworkPolicy,
  SANDBOX_DENY_ALL_EGRESS,
  toE2bCreateNetwork
} from "./sandbox-network-policy.js";

// The structural types in e2b-sandbox.ts are kept in sync with the SDK by hand.
// These tests fail on an SDK upgrade that renames a call or a wire field,
// before a sandbox runs under a policy that the provider no longer reads. The
// SDK talks to a server on this machine (E2B_API_URL), so no request leaves it.

type Recorded = { method: string; path: string; body: unknown };
const requests: Recorded[] = [];
let server: Server;
let previousApiUrl: string | undefined;
// How the stub answers. "silent" never answers, like a provider that hangs.
let mode: "error-500" | "unavailable-503" | "silent" = "error-500";
// Whether the stub accepts a `connect`, so that a test can get a Sandbox instance.
let connectable = false;

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: request.method ?? "", path: request.url ?? "", body: text ? JSON.parse(text) : undefined });
      if (connectable && request.method === "POST" && /\/sandboxes\/[^/]+\/connect$/.test(request.url ?? "")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          sandboxID: "sbx-1", templateID: "tpl", clientID: "client", envdVersion: "0.2.4",
          domain: "e2b.app", envdAccessToken: "token", trafficAccessToken: "traffic", state: "running"
        }));
        return;
      }
      if (mode === "silent") return;
      const status = mode === "unavailable-503" ? 503 : 500;
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: status, message: "stub" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  previousApiUrl = process.env.E2B_API_URL;
  process.env.E2B_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (previousApiUrl === undefined) delete process.env.E2B_API_URL;
  else process.env.E2B_API_URL = previousApiUrl;
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  requests.length = 0;
  mode = "error-500";
  connectable = false;
});

/**
 * The options of `Sandbox.create` exactly as the backend builds them, plus a request timeout
 * so that a test never waits for the SDK default of 60 s. These must not be written by hand
 * here: the test is there to check what the backend sends, `retries` included.
 */
function productionCreateOptions(policy = resolveSandboxNetworkPolicy([])) {
  return {
    ...toE2bCreateOptions({
      apiKey: "e2b_test_key",
      timeoutMs: 60_000,
      metadata: { provider: "deep-agents", sessionId: "sess-1", runtimeId: "rt-1" },
      network: toE2bCreateNetwork(policy)
    }),
    requestTimeoutMs: 5_000
  };
}

const createRequests = () => requests.filter((request) => request.method === "POST" && request.path.endsWith("/v2/sandboxes"));

describe("E2B SDK surface used by the sandbox network policy", () => {
  it("still has the calls and the constant that the backend relies on", async () => {
    const SandboxClass = await loadE2bSandboxClass();
    expect(typeof SandboxClass.create).toBe("function");
    expect(typeof SandboxClass.connect).toBe("function");
    expect(typeof SandboxClass.getInfo).toBe("function");
    expect(typeof Sandbox.prototype.kill).toBe("function");
    expect(ALL_TRAFFIC).toBe(SANDBOX_DENY_ALL_EGRESS);
  });

  it("sends the creation policy in the fields that the provider reads, with the options of the backend", async () => {
    const policy = resolveSandboxNetworkPolicy(["pypi.org", "*.example.com"]);

    await expect(Sandbox.create("tpl", productionCreateOptions(policy))).rejects.toThrow();

    const create = createRequests()[0];
    expect(create?.body).toMatchObject({
      templateID: "tpl",
      timeout: 60,
      metadata: { provider: "deep-agents", sessionId: "sess-1", runtimeId: "rt-1" },
      network: { denyOut: ["0.0.0.0/0"], allowOut: ["*.example.com", "pypi.org"], allowPublicTraffic: false }
    });
    // A policy that is only a label would leave these out and open the network.
    expect(create?.body).not.toHaveProperty("allow_internet_access");
  });

  // A request that creates a resource must not be sent twice. A gateway can answer 503 after the
  // provider made the sandbox, and a second request would make a second one that nothing kills.
  it("sends the request that creates a sandbox once, when the provider answers 503", async () => {
    mode = "unavailable-503";

    await expect(Sandbox.create("tpl", productionCreateOptions())).rejects.toThrow();

    expect(createRequests()).toHaveLength(1);
  });

  it("would send it again with the default of the SDK, which is why the options set retries to 0", async () => {
    mode = "unavailable-503";
    const { retries: _retries, ...withoutRetries } = productionCreateOptions();

    await expect(Sandbox.create("tpl", withoutRetries)).rejects.toThrow();

    // 1 + 3 retries. If the SDK stops doing this, the test above no longer proves anything.
    expect(createRequests().length).toBeGreaterThan(1);
    expect(toE2bCreateOptions({
      apiKey: "k", timeoutMs: 1, metadata: {}, network: toE2bCreateNetwork(resolveSandboxNetworkPolicy([]))
    }).retries).toBe(0);
  });
});

// The backend bounds every request of a network check with a timeout and a
// signal, and retries a failed read itself. These cases check, against the real
// SDK and a stub server, the behavior that this relies on.
describe("E2B SDK time limits and retries used by the network check", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const readRequests = () => requests.filter((request) => request.method === "GET" && request.path.endsWith("/sandboxes/sbx-1"));

  it("does not retry an HTTP 500 itself, so the backend has to", async () => {
    // Default retries: the SDK retries a 429, 502 and 503 only.
    await expect(Sandbox.getInfo("sbx-1", { apiKey: "e2b_test_key", requestTimeoutMs: 5_000 })).rejects.toMatchObject({ statusCode: 500 });

    expect(readRequests()).toHaveLength(1);
  });

  it("stops waiting for a read at the request timeout, with an error that is not a gone sandbox", async () => {
    mode = "silent";
    const startedAt = Date.now();

    const failure = await Sandbox.getInfo("sbx-1", { apiKey: "e2b_test_key", requestTimeoutMs: 300 }).catch((error: unknown) => error);

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(failure).toMatchObject({ name: "TimeoutError" });
    // The backend retries this kind of failure and never replaces a sandbox for it.
    expect(isSandboxGoneError(failure)).toBe(false);
  });

  it("cancels a read, and the SDK's own retries of a 503, when the signal aborts", async () => {
    mode = "unavailable-503";

    const failure = await Sandbox.getInfo("sbx-1", {
      apiKey: "e2b_test_key", requestTimeoutMs: 5_000, signal: AbortSignal.timeout(400)
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    const atSettle = requests.length;
    expect(atSettle).toBeGreaterThanOrEqual(1);
    // Nothing is sent after the call has ended: a request that outlives the
    // check keeps a connection and a retry loop alive.
    await sleep(800);
    expect(requests.length).toBe(atSettle);
  });

  it("gives a kill on a connected sandbox the same time limit and signal", async () => {
    connectable = true;
    const sandbox = await Sandbox.connect("sbx-1", { apiKey: "e2b_test_key", timeoutMs: 60_000 } as never);
    mode = "silent";

    const byTimeout = await sandbox.kill({ requestTimeoutMs: 300 }).catch((error: unknown) => error);
    const bySignal = await sandbox.kill({ signal: AbortSignal.timeout(300) }).catch((error: unknown) => error);

    expect(byTimeout).toMatchObject({ name: "TimeoutError" });
    expect(bySignal).toBeInstanceOf(Error);
    expect(isSandboxGoneError(byTimeout)).toBe(false);
    expect(requests.filter((request) => request.method === "DELETE")).toHaveLength(2);
  });
});

// VULN-13: the network of a sandbox is fixed when it is created. The SDK has a
// call that changes the egress rules of a running sandbox, and the backend must
// not be able to call it: two replicas that each hold an old request can undo
// each other's change, and a request that was sent cannot be recalled. A
// sandbox that does not match its policy is replaced. These cases keep that
// call out of the interface that the backend uses, and out of the source.
describe("no way to change the network of a running sandbox", () => {
  const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
    });
  }

  it("has no mention of the SDK method that changes the network, anywhere in the backend source", () => {
    const offenders = sourceFiles(srcRoot)
      .filter((file) => /update_?network/i.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(srcRoot, file));

    expect(offenders).toEqual([]);
  });

  it("leaves the method out of the interface of a sandbox, and out of the class", () => {
    const sandbox = null as unknown as E2bSandboxLike;
    const sandboxClass = null as unknown as E2bSandboxClassLike;
    // These lines fail to compile if the method is added back: typecheck:test checks them.
    // @ts-expect-error the interface has no way to change the network of a running sandbox
    void sandbox?.updateNetwork;
    // @ts-expect-error neither has the static side of the class
    void sandboxClass?.updateNetwork;
    expect(sandbox).toBeNull();
  });

  it("knows that the SDK still has the method, which is why the interface leaves it out", async () => {
    // A backend that reached the method through the module itself would be caught by the source scan above.
    expect(typeof Sandbox.prototype.updateNetwork).toBe("function");
    expect(await loadE2bSandboxClass()).toBe(Sandbox);
  });
});
