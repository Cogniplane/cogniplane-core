import { expect, it } from "vitest";
import type { AdminMcpServer, AdminModelCatalogResponse, ModelSpendingResponse, OrganizationSkillSubmission } from "@cogniplane/shared-types";
import { makeTenantSettings } from "../../../test-helpers/tenant-settings";
import { budgetItems, budgetRoutineLine, connectionItems, modelItems, submissionAge, submissionItems } from "./work-queue";

function submission(id: string, submittedAt: string, status: OrganizationSkillSubmission["status"] = "pending"): OrganizationSkillSubmission {
  return { id, version: 1, status, authorUserId: "author", authorName: `Author ${id}`, authorEmail: null,
    sourceSkillId: "personal-skill-1", targetOrganizationSkillId: null, acceptedOrganizationSkillId: null,
    latest: { attempt: 1, status, note: "", snapshot: { content: { name: `skill-${id}`, description: "Description", instructions: "Instructions" }, sourceRevision: 1, contentHash: "a".repeat(64), validationMessages: [] }, submittedAt, decidedAt: null, decidedBy: null, decidedByName: null, feedback: null, acceptedRevisionId: null },
    createdAt: submittedAt, updatedAt: submittedAt };
}

function server(overrides: Partial<AdminMcpServer>): AdminMcpServer {
  return { serverId: "server-one", serverName: "Server one", description: null, transportKind: "http", mode: "proxy", routePath: "/mcp/server-one", upstreamUrl: null,
    upstreamAuthType: "none", upstreamAuthName: null, upstreamAuthConfigured: false, version: 1, configHash: "hash", enabled: true, isPublished: false, isAllowed: true,
    createdBy: "owner", createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", ...overrides };
}

it("sorts pending submissions oldest first and uses the latest submission date for age", () => {
  const items = submissionItems([submission("new", "2026-09-26T00:00:00Z"), submission("done", "2026-09-01T00:00:00Z", "accepted"), submission("old", "2026-09-23T00:00:00Z")], Date.parse("2026-09-26T12:00:00Z"));
  expect(items.map((item) => item.title)).toEqual(["skill-old", "skill-new"]);
  expect(items[0]).toMatchObject({ detail: "Submitted by Author old", meta: "3 days waiting", href: "/admin/skills?view=review&submission=old" });
  expect(submissionAge("2026-09-25T12:00:00Z", Date.parse("2026-09-26T12:00:00Z"))).toBe("1 day waiting");
});

it("flags enabled connection setup only when the organization can act", () => {
  const settings = makeTenantSettings({ enabledMcpServerIds: ["server-one"] });
  expect(connectionItems([server({})], settings)[0].detail).toBe("Add an upstream URL.");
  expect(connectionItems([server({ enabled: false })], settings)).toEqual([]);
  expect(connectionItems([server({ isAllowed: false })], settings)).toEqual([]);
  expect(connectionItems([server({ upstreamUrl: "https://example.test/mcp", credentialScope: "personal", upstreamAuthType: "bearer" })], settings)).toEqual([]);
  expect(connectionItems([server({ upstreamUrl: "https://example.test/mcp", credentialScope: "organization", upstreamAuthType: "bearer" })], settings)[0].detail).toBe("Add an authentication secret.");
});

it("shows enabled provider key blockers and a fallback when there are no usable models", () => {
  const settings = makeTenantSettings({ enabledProviders: ["openai"], enabledModelIds: null });
  const catalog: AdminModelCatalogResponse = { models: [], providers: [{ id: "openai", label: "OpenAI", keySource: "none" }, { id: "anthropic", label: "Anthropic", keySource: "none" }] };
  expect(modelItems(catalog, settings).map((item) => item.href)).toEqual(["/admin/models?provider=openai", "/admin/models"]);
  expect(modelItems({ ...catalog, providers: [] }, settings)[0].title).toBe("No models available");
});

it("distinguishes missing model selection from a missing provider key", () => {
  const catalog: AdminModelCatalogResponse = {
    models: [{ id: "openai/model", displayName: "Model", description: "", provider: "openai", isDefault: false, supportedEfforts: [], defaultEffort: null, contextWindow: 1000 }],
    providers: [{ id: "openai", label: "OpenAI", keySource: "none" }]
  };
  const settings = makeTenantSettings({ enabledProviders: ["openai"], enabledModelIds: [] });
  const setupMessage = "Enable a provider and at least one model to make AI work available.";
  expect(modelItems(catalog, settings).find((item) => item.id === "models:none")?.detail).toBe(setupMessage);
  expect(modelItems({ ...catalog, models: [] }, { ...settings, enabledModelIds: null }).find((item) => item.id === "models:none")?.detail).toBe(setupMessage);
  expect(modelItems(catalog, { ...settings, enabledModelIds: null }).find((item) => item.id === "models:none")?.detail).toBe("Add a provider key so an enabled model can be used.");
  expect(modelItems({ ...catalog, providers: [{ id: "openai", label: "OpenAI", keySource: "tenant" }] }, { ...settings, enabledModelIds: null })).toEqual([]);
});

function spending(limit: number | null, charged: number, extra: Partial<ModelSpendingResponse> & { reservation?: number } = {}): ModelSpendingResponse {
  const { reservation = 1, ...rest } = extra;
  return { policy: { monthlyLimitUsd: limit, turnReservationUsd: reservation, version: 1 }, chargedUsd: charged,
    activeReservations: 0, unknownReservations: 0, unresolved: [], nextCursor: null, ...rest };
}

it("adds one budget item and puts states that block new turns before the warning", () => {
  expect(budgetItems(spending(100, 79))).toEqual([]);
  expect(budgetItems(spending(100, 80))[0]).toMatchObject({ id: "budget:approaching", title: "Monthly budget 80% used",
    detail: "$80.00 of $100.00 charged or held. New turns stop when less than $1.00 remains.", href: "/admin/token-usage" });
  expect(budgetItems(spending(100, 99.5))).toMatchObject([{ id: "budget:exhausted", action: "Change budget", href: "/admin/token-usage?budget=edit" }]);
  expect(budgetItems(spending(10, 1, { reservation: 20 }))[0]!.id).toBe("budget:exhausted");
  const unknown = budgetItems(spending(100, 99.5, { unknownReservations: 2 }));
  expect(unknown).toHaveLength(1);
  expect(unknown[0]).toMatchObject({ id: "budget:unknown", href: "/admin/token-usage?budget=recovery",
    detail: "2 reservations this month have unknown usage. Reconcile them with the verified cost to start new turns. The remaining budget is also too small for one turn." });
});

it("flags a zero limit without dividing by it", () => {
  expect(budgetItems(spending(0, 0))).toMatchObject([{ id: "budget:off", title: "New turns are paused",
    detail: "The monthly limit is $0.00. No new chat or scheduled turn can start until you change the limit." }]);
  expect(budgetItems(spending(0, 3, { unknownReservations: 1 }))[0]!.id).toBe("budget:off");
});

it("says that a $0 limit pauses new turns until changed, not until the month ends", () => {
  const line = budgetRoutineLine(spending(0, 0), "2026-09");
  expect(line).toBe("New turns are paused by the $0 monthly limit until you change it.");
  expect(line).not.toMatch(/model work|September/i);
});

it("keeps micro-dollar precision and mentions released holds when a turn does not fit", () => {
  const [item] = budgetItems(spending(1.000001, 0, { reservation: 1.000002, activeReservations: 1 }));
  expect(item).toMatchObject({ id: "budget:exhausted", title: "Not enough budget for a new turn",
    detail: "$0.00 of $1.000001 charged or held. A new turn holds $1.000002, which is more than what remains now. Room returns when running turns end and release unused holds." });
  expect(budgetItems(spending(1.000002, 0, { reservation: 1.000002 }))).toEqual([]);
});

it("never says blocked without a limit, but still reminds about recovery", () => {
  const unlimited = spending(null, 50, { unknownReservations: 1 });
  expect(budgetItems(unlimited)).toEqual([]);
  const line = budgetRoutineLine(unlimited, "2026-09");
  expect(line).toBe("No monthly limit. Some reservations still need recovery.");
  expect(line).not.toMatch(/block/i);
});

it("mentions older open reservations without counting them from one page", () => {
  const old = { reservationId: "r", sessionId: "s", turnContext: "interactive" as const, period: "2026-08", status: "unknown" as const, chargedMicroUsd: 1, updatedAt: "2026-08-31T00:00:00Z" };
  expect(budgetRoutineLine(spending(100, 5, { unresolved: [old] }), "2026-09")).toBe("$5.00 of $100.00 charged or held in September 2026 (UTC). Some reservations still need recovery.");
  expect(budgetItems(spending(100, 5, { unresolved: [old] }))).toEqual([]);
});
