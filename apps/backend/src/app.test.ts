import { test, expect, describe } from "vitest";
import Fastify from "fastify";

import { handleAppError, parseTrustProxy } from "./app.js";

describe("parseTrustProxy", () => {
  test("defaults to a single trusted hop for the documented ALB topology", () => {
    expect(parseTrustProxy("1")).toBe(1);
  });

  test("treats empty / false as untrusted (socket peer)", () => {
    expect(parseTrustProxy("")).toBe(false);
    expect(parseTrustProxy("false")).toBe(false);
    expect(parseTrustProxy("FALSE")).toBe(false);
  });

  test("treats true as trust-all", () => {
    expect(parseTrustProxy("true")).toBe(true);
  });

  test("parses a hop count", () => {
    expect(parseTrustProxy("2")).toBe(2);
  });

  test("passes a CIDR/IP list through as a string", () => {
    expect(parseTrustProxy("10.0.0.0/8,172.16.0.0/12")).toBe("10.0.0.0/8,172.16.0.0/12");
  });
});

test("trustProxy resolves request.ip from X-Forwarded-For when trusting one hop", async () => {
  // With trustProxy=1 the rightmost XFF entry (appended by the trusted proxy)
  // wins, so a client-forged leftmost entry cannot spoof request.ip.
  const app = Fastify({ logger: false, trustProxy: parseTrustProxy("1") });
  app.get("/whoami", async (request) => ({ ip: request.ip }));

  const response = await app.inject({
    method: "GET",
    url: "/whoami",
    remoteAddress: "10.0.0.5",
    headers: { "x-forwarded-for": "203.0.113.7" }
  });
  expect(response.json().ip).toBe("203.0.113.7");
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
