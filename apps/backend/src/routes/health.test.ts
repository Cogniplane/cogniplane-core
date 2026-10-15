import Fastify from "fastify";
import { afterEach, expect, test, vi } from "vitest";

import type { Pool } from "../lib/db.js";
import { registerHealthRoutes } from "./health.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function healthApp(query: () => Promise<unknown>) {
  const app = Fastify();
  app.decorate("db", { query } as unknown as Pool);
  await registerHealthRoutes(app);
  await app.ready();
  return app;
}

test("liveness stays available during a database outage without querying Postgres", async () => {
  const query = vi.fn().mockRejectedValue(new Error("database unavailable"));
  const app = await healthApp(query);
  try {
    const response = await app.inject("/health");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expect(query).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

test("readiness checks Postgres before reporting ready", async () => {
  const query = vi.fn().mockResolvedValue({ rows: [{ "?column?": 1 }] });
  const app = await healthApp(query);
  try {
    const response = await app.inject("/ready");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expect(query).toHaveBeenCalledWith("SELECT 1");
  } finally {
    await app.close();
  }
});

test("readiness reports unavailable without exposing database errors", async () => {
  const app = await healthApp(vi.fn().mockRejectedValue(new Error("private database details")));
  try {
    const response = await app.inject("/ready");
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "unavailable" });
  } finally {
    await app.close();
  }
});

test("readiness deadline also bounds waiting for a pool connection", async () => {
  const app = await healthApp(() => new Promise(() => {}));
  vi.useFakeTimers();
  try {
    const response = app.inject("/ready");
    await vi.advanceTimersByTimeAsync(2_001);
    expect((await response).statusCode).toBe(503);
  } finally {
    await app.close();
  }
});

test.each(["/health", "/ready"])("%s returns a bare status without build, uptime or runtime data", async (url) => {
  vi.stubEnv("BUILD_SHA", "0123456789abcdef0123456789abcdef01234567");
  vi.stubEnv("BUILD_DATE", "2026-10-13T01:37:23Z");
  const app = await healthApp(vi.fn().mockResolvedValue({ rows: [] }));
  try {
    const response = await app.inject(url);
    expect(response.statusCode).toBe(200);
    // Monitors match this exact text (deploy/homelab/monitor.sh).
    expect(response.body).toBe('{"status":"ok"}');
    expect(response.body).not.toContain("0123456789abcdef");
    expect(response.body).not.toContain("2026-10-13");
  } finally {
    await app.close();
  }
});
