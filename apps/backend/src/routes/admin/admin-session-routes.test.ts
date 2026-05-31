import { test, expect } from "vitest";
import Fastify from "fastify";

import type { Pool } from "../../lib/db.js";
import { registerAdminSessionRoutes } from "./admin-session-routes.js";
import { adminSessionsListQuerySchema } from "./admin-route-schemas.js";

type FakeRow = Record<string, unknown>;

type AlertRows = {
  pii?: FakeRow[];
  approvals?: FakeRow[];
  errors?: FakeRow[];
  usage?: FakeRow[];
};

function makeFakeDb(
  sessionRows: FakeRow[] = [],
  alertRows: AlertRows = {}
): {
  db: Pool;
  capturedQueries: { text: string; values: unknown[] }[];
} {
  const capturedQueries: { text: string; values: unknown[] }[] = [];

  const fakeClient = {
    query: async (text: string, values?: unknown[]) => {
      capturedQueries.push({ text, values: values ?? [] });
      if (text.includes("BEGIN") || text.includes("set_config") || text.includes("COMMIT")) {
        return { rows: [], rowCount: 0 };
      }
      // The main sessions SELECT is identified by its outer "FROM sessions s".
      // The route asks for limit+1 rows (LIMIT $9) to detect "has more"; a real
      // DB would honor that LIMIT, so the fake slices the fixture to match. This
      // makes items.length a behavioral proxy for the limit+1 fetch.
      if (text.includes("FROM sessions s")) {
        const limitParam = Number((values ?? [])[8]);
        const limited =
          Number.isFinite(limitParam) && limitParam > 0
            ? sessionRows.slice(0, limitParam)
            : sessionRows;
        return { rows: limited, rowCount: limited.length };
      }
      if (text.includes("FROM pii_scan_runs")) {
        return { rows: alertRows.pii ?? [], rowCount: alertRows.pii?.length ?? 0 };
      }
      if (text.includes("FROM approvals")) {
        return { rows: alertRows.approvals ?? [], rowCount: alertRows.approvals?.length ?? 0 };
      }
      if (text.includes("FROM messages")) {
        return { rows: alertRows.errors ?? [], rowCount: alertRows.errors?.length ?? 0 };
      }
      if (text.includes("FROM resource_activations")) {
        return { rows: alertRows.usage ?? [], rowCount: alertRows.usage?.length ?? 0 };
      }
      throw new Error(`Unexpected query in fake: ${text.slice(0, 100)}`);
    },
    release: () => {}
  };

  const db = {
    connect: async () => fakeClient,
    query: async (text: string, values?: unknown[]) => {
      capturedQueries.push({ text, values: values ?? [] });
      return { rows: [], rowCount: 0 };
    }
  } as unknown as Pool;

  return { db, capturedQueries };
}

async function buildApp(opts: {
  isAdmin: boolean;
  rows?: FakeRow[];
  alerts?: AlertRows;
}) {
  const app = Fastify();
  const { db, capturedQueries } = makeFakeDb(opts.rows ?? [], opts.alerts ?? {});

  app.decorate("db", db);
  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: request.headers["x-user-id"]?.toString() || "tester",
      tenantId: request.headers["x-tenant-id"]?.toString() || "tenant-a",
      isAdmin: opts.isAdmin,
      role: opts.isAdmin ? ("admin" as const) : ("member" as const)
    };
  });

  await registerAdminSessionRoutes(app);
  await app.ready();
  return { app, capturedQueries };
}

test("admin sessions list — non-admin gets 403", async () => {
  const { app } = await buildApp({ isAdmin: false });
  const res = await app.inject({ method: "GET", url: "/admin/sessions" });
  expect(res.statusCode).toBe(403);
  await app.close();
});

test("admin sessions list — empty result returns items: [] and nextCursor: null", async () => {
  const { app } = await buildApp({ isAdmin: true, rows: [] });
  const res = await app.inject({ method: "GET", url: "/admin/sessions" });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.items).toEqual([]);
  expect(body.nextCursor).toBe(null);
  await app.close();
});

test("admin sessions list — maps row fields to camelCase response shape", async () => {
  const created = new Date("2026-04-20T10:00:00Z");
  const lastActivity = new Date("2026-04-22T15:30:00Z");
  const { app } = await buildApp({
    isAdmin: true,
    rows: [
      {
        session_id: "sess-1",
        user_id: "user-1",
        user_email: "alice@example.com",
        created_at: created,
        admin_status: "active",
        last_activity_at: lastActivity,
        message_count: 7,
        runtime_provider: "codex",
        last_model_name: "gpt-5.1"
      }
    ]
  });

  const res = await app.inject({ method: "GET", url: "/admin/sessions" });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.items.length).toBe(1);
  expect(body.items[0]).toEqual({
        sessionId: "sess-1",
        userId: "user-1",
        userEmail: "alice@example.com",
        createdAt: created.toISOString(),
        lastActivityAt: lastActivity.toISOString(),
        messageCount: 7,
        runtimeProvider: "codex",
        modelName: "gpt-5.1",
        status: "active",
        alerts: [],
        skillsUsedCount: 0,
        mcpServersUsedCount: 0
      });
  await app.close();
});

test("admin sessions list — populates skillsUsedCount and mcpServersUsedCount from resource_activations", async () => {
  const created = new Date("2026-04-20T10:00:00Z");
  const lastActivity = new Date("2026-04-22T15:30:00Z");
  const { app } = await buildApp({
    isAdmin: true,
    rows: [
      {
        session_id: "sess-1",
        user_id: "user-1",
        user_email: null,
        created_at: created,
        admin_status: "active",
        last_activity_at: lastActivity,
        message_count: 1,
        runtime_provider: "codex",
        last_model_name: null
      },
      {
        session_id: "sess-2",
        user_id: "user-2",
        user_email: null,
        created_at: created,
        admin_status: "active",
        last_activity_at: lastActivity,
        message_count: 1,
        runtime_provider: "codex",
        last_model_name: null
      }
    ],
    alerts: {
      usage: [
        { session_id: "sess-1", resource_type: "skill", distinct_invoked: "3" },
        { session_id: "sess-1", resource_type: "mcp_server", distinct_invoked: "2" },
        { session_id: "sess-2", resource_type: "mcp_server", distinct_invoked: "1" }
      ]
    }
  });

  const res = await app.inject({ method: "GET", url: "/admin/sessions" });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  const byId = new Map<string, { skillsUsedCount: number; mcpServersUsedCount: number }>();
  for (const item of body.items as Array<{
    sessionId: string;
    skillsUsedCount: number;
    mcpServersUsedCount: number;
  }>) {
    byId.set(item.sessionId, {
      skillsUsedCount: item.skillsUsedCount,
      mcpServersUsedCount: item.mcpServersUsedCount
    });
  }
  expect(byId.get("sess-1")).toEqual({ skillsUsedCount: 3, mcpServersUsedCount: 2 });
  expect(byId.get("sess-2")).toEqual({ skillsUsedCount: 0, mcpServersUsedCount: 1 });
  await app.close();
});

test("admin sessions list — paginates and emits nextCursor when more rows than limit", async () => {
  const baseTime = Date.parse("2026-04-01T00:00:00Z");
  const rows: FakeRow[] = [];
  for (let i = 0; i < 51; i += 1) {
    const offsetMs = i * 60_000;
    rows.push({
      session_id: `sess-${i}`,
      user_id: "user-1",
      user_email: null,
      created_at: new Date(baseTime + offsetMs),
      admin_status: "active",
      last_activity_at: new Date(baseTime + offsetMs + 1000),
      message_count: 1,
      runtime_provider: "codex",
      last_model_name: null
    });
  }

  const { app, capturedQueries } = await buildApp({ isAdmin: true, rows });
  const res = await app.inject({ method: "GET", url: "/admin/sessions?limit=50" });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  // 51 rows available, limit=50. The fake honors the LIMIT the route binds, so
  // getting 50 items back (with rows still pending) proves the route fetched
  // limit+1 to detect "has more" and trimmed the overflow row off the page.
  expect(body.items.length).toBe(50);
  expect(body.nextCursor).not.toBe(null);

  // The LIMIT bind is the only observable signal that the route requested
  // limit+1 rather than limit; the fake's slice above turns it into the
  // items.length assertion, but we also confirm the bound value carries the +1.
  const selectQuery = capturedQueries.find((q) => q.text.includes("FROM sessions s"));
  expect(selectQuery).toBeTruthy();
  expect(selectQuery!.values).toContain(51);
  await app.close();
});

test("admin sessions list — rejects malformed cursor with 400", async () => {
  const { app } = await buildApp({ isAdmin: true });
  const res = await app.inject({
    method: "GET",
    url: "/admin/sessions?cursor=not-base64-json"
  });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toBe("invalid_cursor");
  await app.close();
});

test("admin sessions list — accepts a valid cursor", async () => {
  const { app, capturedQueries } = await buildApp({ isAdmin: true, rows: [] });
  const cursor = Buffer.from(
    JSON.stringify({ lastActivityAt: "2026-04-22T15:30:00Z", sessionId: "sess-x" }),
    "utf8"
  ).toString("base64url");
  const res = await app.inject({
    method: "GET",
    url: `/admin/sessions?cursor=${cursor}`
  });
  expect(res.statusCode).toBe(200);
  const selectQuery = capturedQueries.find((q) => q.text.includes("FROM sessions s"));
  expect(selectQuery).toBeTruthy();
  // The decoded cursor's lastActivityAt + sessionId must both reach the query
  // as bound values (order-independent — the route owns the bind layout).
  expect(selectQuery!.values).toContain("2026-04-22T15:30:00Z");
  expect(selectQuery!.values).toContain("sess-x");
  await app.close();
});

test("admin sessions list — rejects unknown alert kind with 400", async () => {
  const { app } = await buildApp({ isAdmin: true });
  const res = await app.inject({
    method: "GET",
    url: "/admin/sessions?alert=not-a-real-alert"
  });
  expect(res.statusCode).toBe(400);
  await app.close();
});

test("admin sessions list — accepts comma-separated alert filter", async () => {
  const { app } = await buildApp({ isAdmin: true });
  const res = await app.inject({
    method: "GET",
    url: "/admin/sessions?alert=pii-blocked,pii-transformed,errored"
  });
  expect(res.statusCode).toBe(200);
  await app.close();
});

test("admin sessions list — invalid status enum is rejected", async () => {
  const { app } = await buildApp({ isAdmin: true });
  const res = await app.inject({
    method: "GET",
    url: "/admin/sessions?status=banana"
  });
  expect(res.statusCode).toBe(400);
  await app.close();
});

test("admin sessions list — passes filters through to SQL parameters", async () => {
  const { app, capturedQueries } = await buildApp({ isAdmin: true, rows: [] });
  await app.inject({
    method: "GET",
    url: "/admin/sessions?userId=u-1&from=2026-04-01T00:00:00Z&to=2026-04-30T23:59:59Z&status=errored&runtime=claude-code"
  });
  const selectQuery = capturedQueries.find((q) => q.text.includes("FROM sessions s"));
  expect(selectQuery).toBeTruthy();
  // Each parsed filter must reach the query as a bound value. Asserting
  // membership (not position) keeps the test green if the route reorders its
  // bind layout, while still proving every filter threads through.
  expect(selectQuery!.values).toContain("u-1");
  expect(selectQuery!.values).toContain("2026-04-01T00:00:00Z");
  expect(selectQuery!.values).toContain("2026-04-30T23:59:59Z");
  expect(selectQuery!.values).toContain("errored");
  expect(selectQuery!.values).toContain("claude-code");
  await app.close();
});

test("adminSessionsListQuerySchema clamps limit to [1, 200]", () => {
  expect(adminSessionsListQuerySchema.parse({}).limit).toBe(50);
  expect(adminSessionsListQuerySchema.parse({ limit: "0" }).limit).toBe(1);
  expect(adminSessionsListQuerySchema.parse({ limit: "999" }).limit).toBe(200);
  expect(adminSessionsListQuerySchema.parse({ limit: "abc" }).limit).toBe(50);
});

test("admin sessions list — populates alerts from the derivation service", async () => {
  const lastActivity = new Date("2026-04-22T15:30:00Z");
  const { app } = await buildApp({
    isAdmin: true,
    rows: [
      {
        session_id: "sess-1",
        user_id: "user-1",
        user_email: "alice@example.com",
        created_at: new Date("2026-04-20T10:00:00Z"),
        admin_status: "active",
        last_activity_at: lastActivity,
        message_count: 3,
        runtime_provider: "codex",
        last_model_name: null
      }
    ],
    alerts: {
      pii: [{ source_session_id: "sess-1", kind: "pii-blocked", count: 2 }],
      approvals: [{ session_id: "sess-1", kind: "approval-pending", count: 1 }],
      errors: [{ session_id: "sess-1", count: 1 }]
    }
  });
  const res = await app.inject({ method: "GET", url: "/admin/sessions" });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.items.length).toBe(1);
  expect(body.items[0].alerts).toEqual([
        { kind: "pii-blocked", count: 2 },
        { kind: "approval-pending", count: 1 },
        { kind: "errored", count: 1 }
      ]);
  await app.close();
});

test("adminSessionsListQuerySchema deduplicates alert kinds", () => {
  const parsed = adminSessionsListQuerySchema.parse({ alert: "pii-blocked,pii-blocked,errored" });
  expect(parsed.alert).toEqual(["pii-blocked", "errored"]);
});
