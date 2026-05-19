import { test, expect } from "vitest";
import type { PoolClient } from "pg";

import { deriveSessionAlerts } from "./admin-session-alerts.js";

type ScriptedRow = Record<string, unknown>;

type QueryScript = {
  pii?: ScriptedRow[];
  approvals?: ScriptedRow[];
  errors?: ScriptedRow[];
};

function makeClient(script: QueryScript) {
  const captured: { text: string; values: unknown[] }[] = [];
  const client = {
    query: async (text: string, values?: unknown[]) => {
      captured.push({ text, values: values ?? [] });
      if (text.includes("FROM pii_scan_runs")) {
        return { rows: script.pii ?? [], rowCount: script.pii?.length ?? 0 };
      }
      if (text.includes("FROM approvals")) {
        return { rows: script.approvals ?? [], rowCount: script.approvals?.length ?? 0 };
      }
      if (text.includes("FROM messages")) {
        return { rows: script.errors ?? [], rowCount: script.errors?.length ?? 0 };
      }
      throw new Error(`Unexpected query: ${text.slice(0, 80)}…`);
    }
  } as unknown as Pick<PoolClient, "query">;

  return { client, captured };
}

test("deriveSessionAlerts — empty sessionIds short-circuits without queries", async () => {
  const { client, captured } = makeClient({});
  const result = await deriveSessionAlerts(client, "tenant-a", []);
  expect(result.size).toBe(0);
  expect(captured.length).toBe(0);
});

test("deriveSessionAlerts — surfaces pii-blocked badge with count", async () => {
  const { client } = makeClient({
    pii: [{ source_session_id: "s1", kind: "pii-blocked", count: 3 }]
  });
  const result = await deriveSessionAlerts(client, "tenant-a", ["s1"]);
  expect(result.get("s1")).toEqual([{ kind: "pii-blocked", count: 3 }]);
});

test("deriveSessionAlerts — surfaces pii-transformed badge", async () => {
  const { client } = makeClient({
    pii: [{ source_session_id: "s1", kind: "pii-transformed", count: 1 }]
  });
  const result = await deriveSessionAlerts(client, "tenant-a", ["s1"]);
  expect(result.get("s1")).toEqual([{ kind: "pii-transformed", count: 1 }]);
});

test("deriveSessionAlerts — surfaces pii-detected badge", async () => {
  const { client } = makeClient({
    pii: [{ source_session_id: "s1", kind: "pii-detected", count: 2 }]
  });
  const result = await deriveSessionAlerts(client, "tenant-a", ["s1"]);
  expect(result.get("s1")).toEqual([{ kind: "pii-detected", count: 2 }]);
});

test("deriveSessionAlerts — ignores rows where kind is null", async () => {
  // The CASE expression returns NULL when no branch matches; SQL would already
  // exclude those via the WHERE, but we belt-and-suspenders the mapping.
  const { client } = makeClient({
    pii: [{ source_session_id: "s1", kind: null, count: 5 }]
  });
  const result = await deriveSessionAlerts(client, "tenant-a", ["s1"]);
  expect(result.size).toBe(0);
});

test("deriveSessionAlerts — surfaces approval-rejected badge", async () => {
  const { client } = makeClient({
    approvals: [{ session_id: "s1", kind: "approval-rejected", count: 1 }]
  });
  const result = await deriveSessionAlerts(client, "tenant-a", ["s1"]);
  expect(result.get("s1")).toEqual([{ kind: "approval-rejected", count: 1 }]);
});

test("deriveSessionAlerts — surfaces approval-pending badge", async () => {
  const { client } = makeClient({
    approvals: [{ session_id: "s1", kind: "approval-pending", count: 4 }]
  });
  const result = await deriveSessionAlerts(client, "tenant-a", ["s1"]);
  expect(result.get("s1")).toEqual([{ kind: "approval-pending", count: 4 }]);
});

test("deriveSessionAlerts — surfaces errored badge from messages.status", async () => {
  const { client } = makeClient({
    errors: [{ session_id: "s1", count: 2 }]
  });
  const result = await deriveSessionAlerts(client, "tenant-a", ["s1"]);
  expect(result.get("s1")).toEqual([{ kind: "errored", count: 2 }]);
});

test("deriveSessionAlerts — drops zero-count entries defensively", async () => {
  const { client } = makeClient({
    errors: [{ session_id: "s1", count: 0 }]
  });
  const result = await deriveSessionAlerts(client, "tenant-a", ["s1"]);
  expect(result.size).toBe(0);
});

test("deriveSessionAlerts — merges multiple badge kinds on the same session in canonical order", async () => {
  const { client } = makeClient({
    pii: [
      { source_session_id: "s1", kind: "pii-detected", count: 1 },
      { source_session_id: "s1", kind: "pii-blocked", count: 1 }
    ],
    approvals: [{ session_id: "s1", kind: "approval-pending", count: 1 }],
    errors: [{ session_id: "s1", count: 1 }]
  });
  const result = await deriveSessionAlerts(client, "tenant-a", ["s1"]);
  const badges = result.get("s1");
  expect(badges).toBeTruthy();
  // Canonical order: pii-blocked < pii-detected < approval-pending < errored
  expect(badges.map((b) => b.kind)).toEqual(["pii-blocked", "pii-detected", "approval-pending", "errored"]);
});

test("deriveSessionAlerts — distributes badges across multiple sessions in one batch", async () => {
  const { client } = makeClient({
    pii: [{ source_session_id: "s1", kind: "pii-blocked", count: 1 }],
    approvals: [{ session_id: "s2", kind: "approval-pending", count: 2 }],
    errors: [{ session_id: "s3", count: 5 }]
  });
  const result = await deriveSessionAlerts(client, "tenant-a", ["s1", "s2", "s3"]);
  expect(result.get("s1")).toEqual([{ kind: "pii-blocked", count: 1 }]);
  expect(result.get("s2")).toEqual([{ kind: "approval-pending", count: 2 }]);
  expect(result.get("s3")).toEqual([{ kind: "errored", count: 5 }]);
});

test("deriveSessionAlerts — passes tenantId and sessionIds to every query", async () => {
  const { client, captured } = makeClient({});
  await deriveSessionAlerts(client, "tenant-a", ["s1", "s2"]);
  expect(captured.length).toBe(3);
  for (const q of captured) {
    expect(q.values[0]).toBe("tenant-a");
    expect(q.values[1]).toEqual(["s1", "s2"]);
  }
});
