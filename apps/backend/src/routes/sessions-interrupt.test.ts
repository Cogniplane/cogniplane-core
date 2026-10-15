import { afterEach, describe, expect, it, vi } from "vitest";

import { ActiveTurnsRegistry } from "../services/active-turns-registry.js";
import { sessionRoutesApp } from "../test-helpers/session-routes-app.js";

vi.mock("../lib/db.js", () => ({ ensureUser: vi.fn() }));

afterEach(() => vi.restoreAllMocks());

const sessionId = "37af657a-2fed-4148-a5fa-ec6b34ccc959";
async function interrupt(stores: Record<string, unknown>, id = sessionId) {
  const app = await sessionRoutesApp(stores);
  return app.inject({ method: "POST", url: `/sessions/${id}/interrupt` });
}

const readable = (overrides: Record<string, unknown> = {}) =>
  vi.fn(async () => ({ sessionId, status: "active", projectId: null, canEdit: true, ...overrides }));

describe("POST /sessions/:sessionId/interrupt", () => {
  it("rejects a malformed session id before any lookup", async () => {
    const getReadable = readable();

    const response = await interrupt({ sessions: { getReadable } }, "not-a-session");

    expect(response.statusCode).toBe(400);
    expect(getReadable).not.toHaveBeenCalled();
  });

  it("answers 404 for a session the caller cannot read, and stops nothing", async () => {
    const getReadable = vi.fn(async () => null);
    const stopAndGetOwner = vi.fn();
    const interruptTurn = vi.fn();

    const response = await interrupt({
      sessions: { getReadable }, executions: { stopAndGetOwner }, runtimeAdapter: { interruptTurn }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "session_not_found" });
    // The caller's own tenant and user decide what is readable.
    expect(getReadable).toHaveBeenCalledWith("tenant", sessionId, "user");
    expect(stopAndGetOwner).not.toHaveBeenCalled();
    expect(interruptTurn).not.toHaveBeenCalled();
  });

  describe("with fenced executions", () => {
    it("answers 409 when there is no execution to stop and no setup to cancel", async () => {
      const activeTurns = new ActiveTurnsRegistry();
      // Another tenant's setup for the same id must not be cancelled.
      activeTurns.mark(sessionId, { tenantId: "other-tenant", userId: "user" });

      const response = await interrupt({
        sessions: { getReadable: readable() },
        executions: { stopAndGetOwner: async () => null },
        activeTurns,
        runtimeAdapter: { interruptTurn: vi.fn() }
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: "no_active_turn" });
      expect(activeTurns.cancelSignal(sessionId)?.aborted).toBe(false);
    });

    it("does not let a viewer cancel setup", async () => {
      const activeTurns = new ActiveTurnsRegistry();
      activeTurns.mark(sessionId, { tenantId: "tenant", userId: "owner" });

      const response = await interrupt({
        sessions: { getReadable: readable({ canEdit: false }) },
        executions: { stopAndGetOwner: async () => null },
        activeTurns,
        runtimeAdapter: { interruptTurn: vi.fn() }
      });

      expect(response.statusCode).toBe(409);
      expect(activeTurns.cancelSignal(sessionId)?.aborted).toBe(false);
    });

    it("signals the local runtime only for the execution it fenced, even if the signal fails", async () => {
      const activeTurns = new ActiveTurnsRegistry();
      activeTurns.mark(sessionId, { tenantId: "tenant", userId: "user" });
      activeTurns.setExecution(sessionId, "turn-1");
      const interruptTurn = vi.fn(async () => { throw new Error("runtime gone"); });
      const stopAndGetOwner = vi.fn(async () => ({ executionId: "turn-1", ownerId: null }));

      const response = await interrupt({
        sessions: { getReadable: readable() }, executions: { stopAndGetOwner }, activeTurns,
        runtimeAdapter: { interruptTurn }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "interrupted" });
      expect(stopAndGetOwner).toHaveBeenCalledWith({ tenantId: "tenant", sessionId, userId: "user" });
      expect(interruptTurn).toHaveBeenCalledWith({ tenantId: "tenant", sessionId, userId: "user" });
      expect(activeTurns.cancelSignal(sessionId)?.aborted).toBe(true);
    });

    it("leaves a newer local execution alone when an older one was fenced", async () => {
      const activeTurns = new ActiveTurnsRegistry();
      activeTurns.mark(sessionId, { tenantId: "tenant", userId: "user" });
      activeTurns.setExecution(sessionId, "turn-2");
      const interruptTurn = vi.fn();

      const response = await interrupt({
        sessions: { getReadable: readable() },
        executions: { stopAndGetOwner: async () => ({ executionId: "turn-1", ownerId: null }) },
        activeTurns,
        runtimeAdapter: { interruptTurn }
      });

      expect(response.statusCode).toBe(200);
      expect(interruptTurn).not.toHaveBeenCalled();
      expect(activeTurns.cancelSignal(sessionId)?.aborted).toBe(false);
    });

    it("still reports the stop when publishing it to the owning replica fails", async () => {
      const publishStop = vi.fn(async () => { throw new Error("redis down"); });

      const response = await interrupt({
        sessions: { getReadable: readable() },
        executions: { stopAndGetOwner: async () => ({ executionId: "turn-1", ownerId: "replica-2" }) },
        turnBus: { publishStop },
        activeTurns: new ActiveTurnsRegistry(),
        runtimeAdapter: { interruptTurn: vi.fn() }
      });

      expect(response.statusCode).toBe(200);
      expect(publishStop).toHaveBeenCalledTimes(1);
    });

    it("audits a cancelled setup and still answers when the audit write fails", async () => {
      const activeTurns = new ActiveTurnsRegistry();
      activeTurns.mark(sessionId, { tenantId: "tenant", userId: "user" });
      const create = vi.fn(async () => { throw new Error("audit table down"); });

      const response = await interrupt({
        sessions: { getReadable: readable() },
        executions: { stopAndGetOwner: async () => null },
        activeTurns,
        runtimeAdapter: { id: "deep-agents", interruptTurn: vi.fn() },
        auditEvents: { create }
      });

      expect(response.statusCode).toBe(200);
      expect(activeTurns.cancelSignal(sessionId)?.aborted).toBe(true);
      expect(create).toHaveBeenCalledWith({
        tenantId: "tenant", sessionId, userId: "user", type: "turn.interrupted", payload: { adapter: "deep-agents" }
      });
    });
  });

  describe("without fenced executions", () => {
    it("answers 501 when the runtime cannot interrupt a turn", async () => {
      const response = await interrupt({ sessions: { getReadable: readable() }, runtimeAdapter: { id: "legacy" } });

      expect(response.statusCode).toBe(501);
      expect(response.json()).toMatchObject({ error: "interrupt_not_supported" });
    });

    it("answers 409 when the runtime has no active turn and no setup to cancel", async () => {
      const create = vi.fn();

      const response = await interrupt({
        sessions: { getReadable: readable() },
        runtimeAdapter: { id: "deep-agents", interruptTurn: vi.fn(async () => "no_active_turn") },
        activeTurns: new ActiveTurnsRegistry(),
        auditEvents: { create }
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: "no_active_turn" });
      expect(create).not.toHaveBeenCalled();
    });

    it("still answers when the interrupt audit write fails", async () => {
      const create = vi.fn(async () => { throw new Error("audit table down"); });

      const response = await interrupt({
        sessions: { getReadable: readable() },
        runtimeAdapter: { id: "deep-agents", interruptTurn: vi.fn(async () => "interrupted") },
        auditEvents: { create }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "interrupted" });
      expect(create).toHaveBeenCalledTimes(1);
    });
  });
});
