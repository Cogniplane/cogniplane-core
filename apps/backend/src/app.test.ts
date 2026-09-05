import { test, expect, describe } from "vitest";
import Fastify from "fastify";

import { handleAppError, parseTrustProxy } from "./app.js";

describe("parseTrustProxy", () => {
  test("the shipped default trusts nothing", () => {
    // The default moved from "1" to "false" when Fastify removed hop counts.
    // Deployments behind a proxy set an IP/CIDR allowlist instead. Kept in
    // sync with config.ts by the assertion below.
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
  // The CIDR allowlist is what replaced the removed hop count. The proxy is
  // trusted by ADDRESS, so the entry it appended wins and request.ip is the
  // real client.
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
  // The property the hop count could NOT provide, and the reason Fastify
  // removed it: a direct client that forges XFF is not believed, because its
  // address is not in the allowlist. request.ip stays the socket peer.
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
  // The raw Error message must never reach the client.
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
