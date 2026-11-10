import { test, expect, describe } from "vitest";
import Fastify from "fastify";

import { handleAppError, parseTrustProxy, registerTrustProxyWarnings } from "./app.js";
import { RequestLimitsUnavailableError } from "./services/redis-request-limits.js";

test("request limit outages return a safe 503 with retry guidance", async () => {
  const app = buildAppWithErrorHandler();
  app.get("/limited", async () => { throw new RequestLimitsUnavailableError(new Error("private redis address")); });
  const response = await app.inject({ method: "GET", url: "/limited" });
  expect(response.statusCode).toBe(503);
  expect(response.headers["retry-after"]).toBe("5");
  expect(response.json().error).toBe("request_limits_unavailable");
  expect(response.body).not.toContain("private redis");
  await app.close();
});

describe("parseTrustProxy", () => {
  test("the shipped default trusts nothing", () => {
    // Deployments behind a proxy set an IP/CIDR allowlist instead.
    expect(parseTrustProxy("false")).toBe(false);
  });

  test("treats empty / false as untrusted (socket peer)", () => {
    expect(parseTrustProxy("")).toBe(false);
    expect(parseTrustProxy("false")).toBe(false);
    expect(parseTrustProxy("FALSE")).toBe(false);
  });

  test("treats true as trust-all", () => {
    expect(parseTrustProxy("true")).toBe(true);
  });

  test("rejects numeric hop counts rather than silently downgrading", () => {
    // Fastify removed hop-count trust as spoofable (GHSA-3m5p-2c4r-xxw2) and
    // fails closed on it. Accepting one here would leave request.ip resolving
    // to the load balancer, quietly corrupting logs and per-IP rate limits.
    // Fail loudly at boot instead.
    expect(() => parseTrustProxy("1")).toThrow(/no longer supported/);
    expect(() => parseTrustProxy("2")).toThrow(/GHSA-3m5p-2c4r-xxw2/);
    expect(() => parseTrustProxy("0")).toThrow(/no longer supported/);
  });

  test("passes a CIDR/IP list through as a string", () => {
    expect(parseTrustProxy("10.0.0.0/8,172.16.0.0/12")).toBe("10.0.0.0/8,172.16.0.0/12");
  });
});

test("trustProxy resolves request.ip from X-Forwarded-For for an allowlisted proxy", async () => {
  // Fastify trusts the proxy by its address. It then uses the client IP that the
  // proxy appended to X-Forwarded-For, so request.ip is the real client.
  const app = Fastify({ logger: false, trustProxy: parseTrustProxy("10.0.0.0/8") });
  app.get("/whoami", async (request) => ({ ip: request.ip }));

  const response = await app.inject({
    method: "GET",
    url: "/whoami",
    remoteAddress: "10.0.0.5",
    headers: { "x-forwarded-for": "203.0.113.7" }
  });
  expect(response.json().ip).toBe("203.0.113.7");
});

test("trustProxy ignores X-Forwarded-For from a peer outside the allowlist", async () => {
  // Fastify ignores X-Forwarded-For from a direct client that forges it, because
  // its address is not in the allowlist. request.ip stays the socket peer. A hop
  // count cannot provide this check.
  const app = Fastify({ logger: false, trustProxy: parseTrustProxy("10.0.0.0/8") });
  app.get("/whoami", async (request) => ({ ip: request.ip }));

  const response = await app.inject({
    method: "GET",
    url: "/whoami",
    remoteAddress: "198.51.100.9",
    headers: { "x-forwarded-for": "203.0.113.7" }
  });
  expect(response.json().ip).toBe("198.51.100.9");
});

// Issue #47: the server cannot see at boot whether a proxy is in front of it.
// So in jwt mode each boot names the risk of the setting, and the first
// forwarded request with TRUST_PROXY=false confirms it.
describe("TRUST_PROXY warnings", () => {
  type LogLine = { level: number; msg: string } & Record<string, unknown>;

  function boot(config: { AUTH_MODE: "jwt" | "dev-headers"; TRUST_PROXY: string }) {
    const lines: LogLine[] = [];
    const app = Fastify({
      logger: { level: "warn", stream: { write: (line: string) => { lines.push(JSON.parse(line)); } } },
      trustProxy: parseTrustProxy(config.TRUST_PROXY)
    });
    registerTrustProxyWarnings(app, config);
    app.get("/whoami", async (request) => ({ ip: request.ip }));
    return { app, lines };
  }

  const warnings = (lines: LogLine[]) => lines.filter((line) => line.level === 40).map((line) => line.msg);

  test("jwt mode warns at every boot while TRUST_PROXY is false, before any request", async () => {
    for (let restart = 0; restart < 2; restart += 1) {
      const { app, lines } = boot({ AUTH_MODE: "jwt", TRUST_PROXY: "false" });
      expect(warnings(lines)).toEqual([expect.stringMatching(/^TRUST_PROXY is false\b.*per-IP sign-in limits/)]);
      await app.close();
    }
  });

  test("jwt mode warns at boot when TRUST_PROXY trusts every peer", async () => {
    const { app, lines } = boot({ AUTH_MODE: "jwt", TRUST_PROXY: "true" });
    expect(warnings(lines)).toEqual([expect.stringMatching(/^TRUST_PROXY is true\b.*X-Forwarded-For/)]);
    await app.close();
  });

  test("an IP/CIDR list boots and forwards without a warning", async () => {
    const { app, lines } = boot({ AUTH_MODE: "jwt", TRUST_PROXY: "10.0.0.0/8" });
    const response = await app.inject({ method: "GET", url: "/whoami", remoteAddress: "10.0.0.5", headers: { "x-forwarded-for": "203.0.113.7" } });
    expect(response.json().ip).toBe("203.0.113.7");
    expect(warnings(lines)).toEqual([]);
    await app.close();
  });

  test("dev-headers mode does not warn at boot", async () => {
    const { app, lines } = boot({ AUTH_MODE: "dev-headers", TRUST_PROXY: "false" });
    expect(warnings(lines)).toEqual([]);
    await app.close();
  });

  test("with TRUST_PROXY=false, the first forwarded request warns once and request.ip stays the peer", async () => {
    const { app, lines } = boot({ AUTH_MODE: "jwt", TRUST_PROXY: "false" });
    const forwarded = () => app.inject({ method: "GET", url: "/whoami", remoteAddress: "10.0.0.5", headers: { "x-forwarded-for": "203.0.113.7" } });

    const first = await forwarded();
    await forwarded();

    expect(first.json().ip).toBe("10.0.0.5");
    expect(warnings(lines)).toEqual([
      expect.stringMatching(/^TRUST_PROXY is false/),
      "Forwarded client IP ignored. Configure TRUST_PROXY with the proxy IP/CIDR so auth rate limits use client IPs."
    ]);
    await app.close();
  });
});

function buildAppWithErrorHandler() {
  // Silence the error log so the test output stays clean; handleAppError still
  // runs the same branch logic.
  const app = Fastify({ logger: false });
  app.setErrorHandler(handleAppError);
  return app;
}

test("500-class errors return an opaque envelope (no internal message leaks)", async () => {
  const app = buildAppWithErrorHandler();
  app.get("/boom", async () => {
    throw new Error("connection string postgres://user:secret@host leaked");
  });

  const response = await app.inject({ method: "GET", url: "/boom" });

  expect(response.statusCode).toBe(500);
  expect(response.json()).toEqual({
    error: "internal_error",
    message: "An unexpected error occurred."
  });
  expect(response.body).not.toContain("secret");
  expect(response.body).not.toContain("postgres://");
});

test("4xx errors are passed through verbatim with their code and message", async () => {
  const app = buildAppWithErrorHandler();
  app.get("/bad", async () => {
    const err = new Error("missing required field 'name'") as Error & {
      statusCode?: number;
      code?: string;
    };
    err.statusCode = 422;
    err.code = "validation_failed";
    throw err;
  });

  const response = await app.inject({ method: "GET", url: "/bad" });

  expect(response.statusCode).toBe(422);
  expect(response.json()).toEqual({
    error: "validation_failed",
    message: "missing required field 'name'"
  });
});

test("Fastify schema validation errors (400) surface as a client error", async () => {
  const app = buildAppWithErrorHandler();
  app.post(
    "/items",
    {
      schema: {
        body: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string" } }
        }
      }
    },
    async () => ({ ok: true })
  );

  const response = await app.inject({ method: "POST", url: "/items", payload: {} });

  expect(response.statusCode).toBe(400);
  const body = response.json();
  // Validation errors are part of the API contract — the message is preserved.
  expect(body.error).toBeDefined();
  expect(body.message).toContain("name");
});

test("an explicit 4xx without a code falls back to bad_request", async () => {
  const app = buildAppWithErrorHandler();
  app.get("/nope", async () => {
    const err = new Error("nope") as Error & { statusCode?: number };
    err.statusCode = 403;
    throw err;
  });

  const response = await app.inject({ method: "GET", url: "/nope" });

  expect(response.statusCode).toBe(403);
  expect(response.json()).toEqual({ error: "bad_request", message: "nope" });
});
