import { describe, it, expect, afterAll, vi } from "vitest";
import { Agent, fetch as undiciFetch } from "undici";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  return {
    ...actual,
    // `permitted.example.test` resolves to a PUBLIC address so the guard
    // permits it; every other name keeps real resolution, so `localhost` still
    // genuinely resolves to loopback for the blocking tests below.
    lookup: vi.fn(async (hostname: string, options?: unknown) => {
      if (hostname === "permitted.example.test") {
        return [{ address: "93.184.216.34", family: 4 }] as never;
      }
      return actual.lookup(hostname, options as never) as never;
    })
  };
});

import { ssrfSafeAgent, ssrfSafeLookup } from "./url-validation.js";

// Why this file exists, separately from url-validation.test.ts:
//
// Those tests call `ssrfSafeLookup` directly. They prove the blocking logic.
// They do not prove the callback shape that undici expects. undici passes
// `{all: true}`, so the hook must call back with an array of {address, family}.
//
// The positive test is the load-bearing one. A failed request looks like a
// working guard, so a suite that only checks blocking can pass with the guard
// broken. A request must get past the lookup hook and reach the transport.
//
// Hermetic by construction: no external network. Real DNS is used only for
// `localhost`, which resolves everywhere. The one case that needs a PUBLIC
// address stubs the resolver instead. (`example.com` needs real DNS, and
// `ip6-localhost` is a Debian-ism that many machines lack. Both are flaky in
// CI.) undici skips the lookup hook for IP-literal hosts, so a literal-IP test
// would exercise nothing.

const servers: Server[] = [];

async function startLoopbackServer(): Promise<number> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("loopback-reached");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function failureMessage(url: string, dispatcher: Agent): Promise<string> {
  try {
    const response = await undiciFetch(url, { dispatcher });
    return `__OK_${response.status}__`;
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause;
    return cause?.message ?? (error as Error).message;
  }
}

afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
});

describe("ssrfSafeAgent through undici", () => {
  it("hands undici a success result it can actually consume", async () => {
    // Capture the arguments that the real hook passes on success, then replay
    // exactly those into undici. Do not wrap the hook or substitute a valid
    // result on error. That would hide the callback bug this test catches.
    //
    // A public hostname is not available in CI. The test stubs the DNS answer, so
    // it covers only the callback shape. The blocking tests cover policy.
    const port = await startLoopbackServer();

    const captured = await new Promise<unknown[]>((resolve) => {
      void ssrfSafeLookup("permitted.example.test", { hints: 32, all: true }, ((
        ...args: unknown[]
      ) => resolve(args)) as never);
    });

    // The hook must report success for a public address...
    expect(captured[0]).toBeNull();

    // ...and undici must be able to connect when replayed those exact args.
    // Redirect to loopback so the connection can actually land on the test
    // server, preserving the captured STRUCTURE exactly — only the address
    // string changes, never the argument shape being verified.
    const replayed = structuredClone(captured) as [unknown, Array<{ address: string }>?];
    if (Array.isArray(replayed[1])) {
      for (const entry of replayed[1]) entry.address = "127.0.0.1";
    }

    const replayAgent = new Agent({
      connect: {
        lookup(_hostname: string, _options: unknown, callback: (...args: never[]) => void) {
          (callback as unknown as (...a: unknown[]) => void)(...replayed);
        }
      } as never
    });

    const result = await failureMessage(`http://localhost:${port}/`, replayAgent);

    expect(result).not.toMatch(/Invalid IP address/i);
    expect(result).toBe("__OK_200__");
  });

  it("refuses a hostname that resolves to loopback", async () => {
    const port = await startLoopbackServer();

    const result = await failureMessage(`http://localhost:${port}/`, ssrfSafeAgent);

    expect(result).not.toMatch(/^__OK_/);
    expect(result).toMatch(/private or reserved/i);
  });

  it("does not leak the resolved internal address in the refusal", async () => {
    // An error naming the internal IP would tell whoever provoked it which
    // address their probe reached.
    const port = await startLoopbackServer();

    const result = await failureMessage(`http://localhost:${port}/`, ssrfSafeAgent);

    expect(result).not.toMatch(/127\.0\.0\.1/);
    expect(result).not.toMatch(/::1/);
  });
});
