import { test, expect } from "vitest";
import Fastify from "fastify";

import type { Pool } from "../../lib/db.js";
import { registerAdminSessionDetailRoute } from "./admin-session-detail.js";

type FakeRow = Record<string, unknown>;

type DetailRows = {
  header?: FakeRow[];
  messages?: FakeRow[];
  approvals?: FakeRow[];
  pii?: FakeRow[];
  audit?: FakeRow[];
  toolEvents?: FakeRow[];
  messageToolResults?: FakeRow[];
  artifacts?: FakeRow[];
  skills?: FakeRow[];
  mcpServers?: FakeRow[];
};

function makeFakeDb(rows: DetailRows = {}): {
  db: Pool;
  capturedQueries: { text: string; values: unknown[] }[];
} {
  const captured: { text: string; values: unknown[] }[] = [];

  const fakeClient = {
    query: async (text: string, values?: unknown[]) => {
      captured.push({ text, values: values ?? [] });
      if (text.includes("BEGIN") || text.includes("set_config") || text.includes("COMMIT")) {
        return { rows: [], rowCount: 0 };
      }
      // Header query: the only query that selects from the aliased sessions
      // table. Routing on `FROM sessions s` alone keeps the fake decoupled from
      // the exact bind-index phrasing of the WHERE clause.
      if (text.includes("FROM sessions s")) {
        return { rows: rows.header ?? [], rowCount: rows.header?.length ?? 0 };
      }
      if (text.includes("FROM messages") && text.includes("ORDER BY created_at ASC")) {
        return { rows: rows.messages ?? [], rowCount: rows.messages?.length ?? 0 };
      }
      if (text.includes("FROM approvals")) {
        return { rows: rows.approvals ?? [], rowCount: rows.approvals?.length ?? 0 };
      }
      if (text.includes("FROM pii_scan_runs")) {
        return { rows: rows.pii ?? [], rowCount: rows.pii?.length ?? 0 };
      }
      if (text.includes("FROM audit_events")) {
        return { rows: rows.audit ?? [], rowCount: rows.audit?.length ?? 0 };
      }
      if (text.includes("FROM tool_events")) {
        return { rows: rows.toolEvents ?? [], rowCount: rows.toolEvents?.length ?? 0 };
      }
      if (text.includes("FROM message_tool_results")) {
        return {
          rows: rows.messageToolResults ?? [],
          rowCount: rows.messageToolResults?.length ?? 0
        };
      }
      if (text.includes("FROM artifacts")) {
        return { rows: rows.artifacts ?? [], rowCount: rows.artifacts?.length ?? 0 };
      }
      if (text.includes("FROM resource_activations") && text.includes("admin_skills")) {
        return { rows: rows.skills ?? [], rowCount: rows.skills?.length ?? 0 };
      }
      if (text.includes("FROM resource_activations") && text.includes("admin_mcp_servers")) {
        return { rows: rows.mcpServers ?? [], rowCount: rows.mcpServers?.length ?? 0 };
      }
      throw new Error(`Unexpected query in fake: ${text.slice(0, 100)}`);
    },
    release: () => {}
  };

  const db = {
    connect: async () => fakeClient,
    query: async (text: string, values?: unknown[]) => {
      captured.push({ text, values: values ?? [] });
      return { rows: [], rowCount: 0 };
    }
  } as unknown as Pool;

  return { db, capturedQueries: captured };
}

async function buildApp(opts: { isAdmin: boolean; rows?: DetailRows }) {
  const app = Fastify();
  const { db, capturedQueries } = makeFakeDb(opts.rows ?? {});
  app.decorate("db", db);
  app.addHook("preHandler", async (request) => {
    request.auth = {
      userId: request.headers["x-user-id"]?.toString() || "tester",
      tenantId: request.headers["x-tenant-id"]?.toString() || "tenant-a",
      isAdmin: opts.isAdmin,
      role: opts.isAdmin ? ("admin" as const) : ("member" as const)
    };
  });
  await registerAdminSessionDetailRoute(app);
  await app.ready();
  return { app, capturedQueries };
}

const VALID_UUID = "11111111-1111-4111-8111-111111111111";

test("admin session detail — non-admin gets 403", async () => {
  const { app } = await buildApp({ isAdmin: false });
  const res = await app.inject({ method: "GET", url: `/admin/sessions/${VALID_UUID}` });
  expect(res.statusCode).toBe(403);
  await app.close();
});

test("admin session detail — malformed sessionId returns 400", async () => {
  const { app } = await buildApp({ isAdmin: true });
  const res = await app.inject({ method: "GET", url: "/admin/sessions/not-a-uuid" });
  expect(res.statusCode).toBe(400);
  await app.close();
});

test("admin session detail — empty header rows returns 404", async () => {
  const { app } = await buildApp({ isAdmin: true, rows: { header: [] } });
  const res = await app.inject({ method: "GET", url: `/admin/sessions/${VALID_UUID}` });
  expect(res.statusCode).toBe(404);
  await app.close();
});

test("admin session detail — happy path returns all sections in camelCase", async () => {
  const created = new Date("2026-04-20T10:00:00Z");
  const lastActivity = new Date("2026-04-22T15:30:00Z");
  const { app } = await buildApp({
    isAdmin: true,
    rows: {
      header: [
        {
          session_id: VALID_UUID,
          user_id: "user-1",
          user_email: "alice@example.com",
          tenant_id: "tenant-a",
          session_name: "Investigation",
          admin_status: "active",
          runtime_provider: "claude-code",
          created_at: created,
          last_activity_at: lastActivity,
          message_count: 4,
          total_cost_usd: 0.123,
          total_tokens: 1500
        }
      ],
      messages: [
        {
          message_id: "m-1",
          role: "user",
          status: "completed",
          content_text: "hello",
          reasoning_content: "",
          plan_content: "",
          model_name: null,
          input_tokens: null,
          output_tokens: null,
          total_tokens: null,
          cost_usd: null,
          detail_json: { foo: 1 },
          created_at: new Date("2026-04-20T10:01:00Z")
        }
      ],
      approvals: [
        {
          approval_id: "ap-1",
          turn_id: "t-1",
          item_id: "item-1",
          request_method: "tools/call",
          kind: "tool",
          title: "run command",
          summary: "ls",
          status: "resolved",
          decision: "approved",
          request_payload: { args: ["ls"] },
          created_at: new Date("2026-04-20T10:02:00Z"),
          resolved_at: new Date("2026-04-20T10:02:30Z")
        }
      ],
      pii: [
        {
          scan_run_id: "scan-1",
          subject_type: "message",
          subject_id: "m-1",
          source_user_id: "user-1",
          mode: "transform",
          provider_type: "openrouter",
          provider_model: "google/gemini-2.5-flash",
          status: "transformed",
          findings_json: [{ kind: "email", count: 2 }],
          summary_text: "2 emails masked",
          action_taken: "transform",
          error_message: null,
          created_at: new Date("2026-04-20T10:03:00Z"),
          completed_at: new Date("2026-04-20T10:03:05Z")
        }
      ],
      audit: [
        {
          event_type: "session.created",
          user_id: "user-1",
          approval_id: null,
          payload: { ok: true },
          ip_address: "10.0.0.1",
          user_agent: "ua",
          created_at: new Date("2026-04-20T10:04:00Z")
        }
      ],
      toolEvents: [
        {
          tool_call_id: "tc-1",
          message_id: "m-1",
          approval_id: "ap-1",
          kind: "shell",
          title: "ls",
          phase: "completed",
          status: "ok",
          duration_ms: 42,
          payload: { stdout: "file.txt" },
          created_at: new Date("2026-04-20T10:05:00Z")
        }
      ],
      artifacts: [
        {
          artifact_id: "art-1",
          artifact_type: "user_upload",
          artifact_name: "report.pdf",
          mime_type: "application/pdf",
          file_size_bytes: 2048,
          status: "ready",
          created_at: new Date("2026-04-20T10:06:00Z")
        }
      ],
      skills: [
        {
          resource_id: "skill-write-artifact",
          name: "write-artifact",
          materialized: true,
          invoked_count: 3
        },
        {
          resource_id: "skill-orphan",
          name: "skill-orphan",
          materialized: true,
          invoked_count: 0
        }
      ],
      mcpServers: [
        {
          resource_id: "managed-session-context",
          name: "Session context",
          materialized: true,
          invoked_count: 7
        }
      ]
    }
  });

  const res = await app.inject({ method: "GET", url: `/admin/sessions/${VALID_UUID}` });
  expect(res.statusCode).toBe(200);
  const body = res.json();

  expect(body.overview).toEqual({
        sessionId: VALID_UUID,
        userId: "user-1",
        userEmail: "alice@example.com",
        tenantId: "tenant-a",
        sessionName: "Investigation",
        status: "active",
        runtimeProvider: "claude-code",
        createdAt: created.toISOString(),
        lastActivityAt: lastActivity.toISOString(),
        messageCount: 4,
        totalCostUsd: 0.123,
        totalTokens: 1500
      });

  expect(body.messages.length).toBe(1);
  expect(body.messages[0].messageId).toBe("m-1");
  expect(body.messages[0].contentText).toBe("hello");
  expect(body.messages[0].detailJson).toEqual({ foo: 1 });

  expect(body.approvals.length).toBe(1);
  expect(body.approvals[0].approvalId).toBe("ap-1");
  expect(body.approvals[0].decision).toBe("approved");
  expect(body.approvals[0].requestPayload).toEqual({ args: ["ls"] });
  expect(body.approvals[0].resolvedAt).toBe(new Date("2026-04-20T10:02:30Z").toISOString());

  expect(body.piiRuns.length).toBe(1);
  expect(body.piiRuns[0].findings).toEqual([{ kind: "email", count: 2 }]);
  expect(body.piiRuns[0].providerModel).toBe("google/gemini-2.5-flash");

  expect(body.auditEvents.length).toBe(1);
  expect(body.auditEvents[0].eventType).toBe("session.created");
  expect(body.auditEvents[0].ipAddress).toBe("10.0.0.1");

  expect(body.toolEvents.length).toBe(1);
  expect(body.toolEvents[0].toolCallId).toBe("tc-1");
  expect(body.toolEvents[0].durationMs).toBe(42);

  expect(body.artifacts.length).toBe(1);
  expect(body.artifacts[0].artifactName).toBe("report.pdf");
  expect(body.artifacts[0].fileSizeBytes).toBe(2048);

  expect(body.skills.length).toBe(2);
  expect(body.skills[0]).toEqual({
        resourceId: "skill-write-artifact",
        name: "write-artifact",
        materialized: true,
        invokedCount: 3
      });
  expect(body.skills[1].invokedCount).toBe(0);

  expect(body.mcpServers.length).toBe(1);
  expect(body.mcpServers[0]).toEqual({
        resourceId: "managed-session-context",
        name: "Session context",
        materialized: true,
        invokedCount: 7
      });

  await app.close();
});

test("admin session detail — empty subsections return [] not null", async () => {
  const { app } = await buildApp({
    isAdmin: true,
    rows: {
      header: [
        {
          session_id: VALID_UUID,
          user_id: "user-1",
          user_email: null,
          tenant_id: "tenant-a",
          session_name: "Empty",
          admin_status: "active",
          runtime_provider: null,
          created_at: new Date("2026-04-20T10:00:00Z"),
          last_activity_at: new Date("2026-04-20T10:00:00Z"),
          message_count: 0,
          total_cost_usd: 0,
          total_tokens: 0
        }
      ]
    }
  });
  const res = await app.inject({ method: "GET", url: `/admin/sessions/${VALID_UUID}` });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.messages).toEqual([]);
  expect(body.approvals).toEqual([]);
  expect(body.piiRuns).toEqual([]);
  expect(body.auditEvents).toEqual([]);
  expect(body.toolEvents).toEqual([]);
  expect(body.messageToolResults).toEqual([]);
  expect(body.artifacts).toEqual([]);
  expect(body.skills).toEqual([]);
  expect(body.mcpServers).toEqual([]);
  await app.close();
});

test("admin session detail — passes tenantId and sessionId to header query", async () => {
  const { app, capturedQueries } = await buildApp({
    isAdmin: true,
    rows: { header: [] }
  });
  await app.inject({
    method: "GET",
    url: `/admin/sessions/${VALID_UUID}`,
    headers: { "x-tenant-id": "tenant-x" }
  });
  const headerQuery = capturedQueries.find((q) => q.text.includes("FROM sessions s"));
  expect(headerQuery).toBeTruthy();
  // Assert the tenant + session id reach the query as bound values, without
  // pinning which positional placeholder ($1 vs $2) each lands in — order is
  // an implementation detail of the query builder, the membership is the
  // contract.
  expect(headerQuery!.values).toContain("tenant-x");
  expect(headerQuery!.values).toContain(VALID_UUID);
  await app.close();
});

test("admin session detail — pii findings non-array fall back to []", async () => {
  const { app } = await buildApp({
    isAdmin: true,
    rows: {
      header: [
        {
          session_id: VALID_UUID,
          user_id: "user-1",
          user_email: null,
          tenant_id: "tenant-a",
          session_name: "x",
          admin_status: "active",
          runtime_provider: "codex",
          created_at: new Date("2026-04-20T10:00:00Z"),
          last_activity_at: new Date("2026-04-20T10:00:00Z"),
          message_count: 0,
          total_cost_usd: 0,
          total_tokens: 0
        }
      ],
      pii: [
        {
          scan_run_id: "s",
          subject_type: "message",
          subject_id: "m",
          source_user_id: null,
          mode: "detect",
          provider_type: null,
          provider_model: null,
          status: "completed",
          findings_json: { not: "an array" },
          summary_text: null,
          action_taken: null,
          error_message: null,
          created_at: new Date("2026-04-20T10:00:00Z"),
          completed_at: null
        }
      ]
    }
  });
  const res = await app.inject({ method: "GET", url: `/admin/sessions/${VALID_UUID}` });
  expect(res.statusCode).toBe(200);
  expect(res.json().piiRuns[0].findings).toEqual([]);
  await app.close();
});
