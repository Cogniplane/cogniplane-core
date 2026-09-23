import Fastify from "fastify";
import { test, expect } from "vitest";

import { workosAuth } from "./auth-workos.js";
import { createTestConfig } from "../test-helpers/test-config.js";

// Browser navigations and <img> requests cannot send the Bearer header. In
// WorkOS mode they must still reach GET /downloads/:token, where the
// single-use token is the credential.
test("WorkOS auth lets GET /downloads/:token through without a Bearer header", async () => {
  const app = Fastify();
  app.addHook("onRequest", workosAuth(createTestConfig({}), { getRole: async () => null }, []));
  app.get("/downloads/:token", async (request) => ({ auth: request.auth ?? null }));
  app.get("/artifacts", async () => ({ ok: true }));

  const download = await app.inject({ method: "GET", url: "/downloads/tok-1" });
  expect(download.statusCode).toBe(200);
  expect(download.json()).toEqual({ auth: null });

  expect((await app.inject({ method: "GET", url: "/artifacts" })).json()).toEqual({ error: "missing_token" });
  expect((await app.inject({ method: "POST", url: "/downloads/tok-1" })).statusCode).toBe(401);
});
