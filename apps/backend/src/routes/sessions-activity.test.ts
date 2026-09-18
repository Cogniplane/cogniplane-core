import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { registerSessionRoutes, type SessionRouteStores } from "./sessions.js";
import { ActiveTurnsRegistry } from "../services/active-turns-registry.js";

vi.mock("../lib/db.js", () => ({ ensureUser: vi.fn() }));

afterEach(() => vi.restoreAllMocks());

it("decorates listed sessions without mutating store records and clears activity after registry removal", async () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-13T12:00:03.456Z"));
  const app = Fastify();
  const activeTurns = new ActiveTurnsRegistry();
  const rows = [Object.freeze({
    sessionId: "owned", userId: "user", sessionName: "Research", status: "active",
    createdAt: "2026-09-13T12:00:00Z", updatedAt: "2026-09-13T12:00:00Z"
  })];
  const list = vi.fn(async () => rows);
  app.addHook("preHandler", async (request) => {
    request.auth = { userId: "user", tenantId: "tenant", role: "member", isAdmin: false };
  });
  await registerSessionRoutes(app, { sessions: { list }, activeTurns } as unknown as SessionRouteStores);
  try {
    activeTurns.mark("owned");
    activeTurns.identify("owned", { messageId: "turn-owned", sequence: 42 });
    activeTurns.mark("foreign");
    const response = await app.inject({ method: "GET", url: "/sessions" });
    expect(response.statusCode).toBe(200);
    expect(list).toHaveBeenCalledWith("tenant", "user", { purposes: undefined });
    expect(response.json().sessions).toHaveLength(1);
    expect(response.json().sessions[0]).toMatchObject({ isRunning: true, activeTurnStartedAt: "2026-09-13T12:00:03.456Z", latestTurnId: "turn-owned", latestTurnSequence: 42, hasTurnFailed: false });
    activeTurns.clear("owned");
    const settled = await app.inject({ method: "GET", url: "/sessions" });
    expect(settled.json().sessions[0].isRunning).toBe(false);
    expect(settled.json().sessions[0].activeTurnStartedAt).toBeUndefined();
  } finally {
    await app.close();
  }
});
