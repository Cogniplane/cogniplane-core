import { expect, test } from "vitest";
import { ZodError } from "zod";
import type { SessionCapabilitySelection } from "@cogniplane/shared-types";
import { FakePool } from "../test-helpers/fake-pool.js";
import { PersonalCapabilityAccessError, PersonalCapabilityStore } from "./personal-capability-store.js";

const available: SessionCapabilitySelection = { skillIds: ["approved-skill"], connectorIds: ["approved-connector"] };

function fixture() {
  const state: {
    member: boolean;
    hasDefaults: boolean;
    selection: unknown;
    version: number;
    failAudit: boolean;
    auditPayloads: unknown[];
  } = { member: true, hasDefaults: false, selection: null, version: 0, failAudit: false, auditPayloads: [] };
  const db = new FakePool()
    .onQuery("FROM tenant_memberships m LEFT JOIN", (_sql, values) => state.member &&
        values[0] === "tenant" && values[1] === "alice"
      ? { rows: [{ capability_selection: state.selection, capability_version: state.version }], rowCount: 1 }
      : { rows: [], rowCount: 0 })
    .onQuery("SELECT 1 FROM tenant_memberships", (_sql, values) => ({
      rows: state.member && values[0] === "tenant" && values[1] === "alice" ? [{ "?column?": 1 }] : [],
      rowCount: state.member && values[0] === "tenant" && values[1] === "alice" ? 1 : 0
    }))
    .onQuery("FROM personal_capability_defaults WHERE", () => state.hasDefaults
      ? { rows: [{ capability_selection: state.selection, capability_version: state.version }], rowCount: 1 }
      : { rows: [], rowCount: 0 })
    .onQuery("INSERT INTO personal_capability_defaults", (_sql, values) => {
      state.hasDefaults = true;
      state.selection = values[2] === null ? null : JSON.parse(String(values[2]));
      state.version = Number(values[3]);
      return { rows: [], rowCount: 1 };
    })
    .onQuery("INSERT INTO audit_events", (_sql, values) => {
      if (state.failAudit) throw new Error("audit unavailable");
      state.auditPayloads.push({ tenantId: values[0], userId: values[2], type: values[4], payload: JSON.parse(String(values[5])) });
      return { rows: [], rowCount: 1 };
    });
  return { state, db, store: new PersonalCapabilityStore(db.asPool()) };
}

test("returns inherited or saved defaults only for a current member", async () => {
  const { state, store } = fixture();
  await expect(store.get("tenant", "alice")).resolves.toEqual({ selection: null, version: 0 });
  state.hasDefaults = true;
  state.selection = { skillIds: ["saved-skill"], connectorIds: [] };
  state.version = 4;
  await expect(store.get("tenant", "alice")).resolves.toEqual({ selection: state.selection, version: 4 });
  await expect(store.get("tenant", "bob")).rejects.toBeInstanceOf(PersonalCapabilityAccessError);
  state.member = false;
  await expect(store.get("tenant", "alice")).rejects.toBeInstanceOf(PersonalCapabilityAccessError);
});

test("saves a custom selection, then restores inheritance with a new version and audit", async () => {
  const { state, store } = fixture();
  const selection = { skillIds: ["approved-skill"], connectorIds: ["approved-connector"] };
  await expect(store.save("tenant", "alice", { selection, version: 0 }, available))
    .resolves.toEqual({ selection, version: 1 });
  await expect(store.get("tenant", "alice")).resolves.toEqual({ selection, version: 1 });
  await expect(store.save("tenant", "alice", { selection: null, version: 1 }, available))
    .resolves.toEqual({ selection: null, version: 2 });
  expect(state.auditPayloads).toEqual([
    { tenantId: "tenant", userId: "alice", type: "personal_capabilities_changed", payload: { selection, version: 1 } },
    { tenantId: "tenant", userId: "alice", type: "personal_capabilities_changed", payload: { selection: null, version: 2 } }
  ]);
});

test("rejects stale writes and new unavailable choices, but preserves an existing unavailable choice", async () => {
  const { state, db, store } = fixture();
  state.hasDefaults = true;
  state.selection = { skillIds: ["old-skill"], connectorIds: [] };
  state.version = 3;
  const requested = { skillIds: ["old-skill", "approved-skill"], connectorIds: [] };
  await expect(store.save("tenant", "alice", { selection: requested, version: 2 }, available)).resolves.toBeNull();
  await expect(store.save("tenant", "alice", { selection: { skillIds: ["old-skill", "unknown"], connectorIds: [] }, version: 3 }, available))
    .resolves.toBeNull();
  await expect(store.save("tenant", "alice", { selection: { skillIds: ["old-skill"], connectorIds: ["unknown"] }, version: 3 }, available))
    .resolves.toBeNull();
  expect(db.queries.filter(({ text }) => text.includes("INSERT INTO personal_capability_defaults") ||
    text.includes("INSERT INTO audit_events"))).toHaveLength(0);
  await expect(store.save("tenant", "alice", { selection: requested, version: 3 }, available))
    .resolves.toEqual({ selection: requested, version: 4 });
  expect(state.auditPayloads).toHaveLength(1);
});

test("denies a revoked member before writing and rejects malformed persisted defaults", async () => {
  const { state, db, store } = fixture();
  state.member = false;
  await expect(store.save("tenant", "alice", { selection: null, version: 0 }, available))
    .rejects.toBeInstanceOf(PersonalCapabilityAccessError);
  expect(db.queries.some(({ text }) => text.includes("INSERT INTO personal_capability_defaults"))).toBe(false);
  state.member = true;
  state.hasDefaults = true;
  state.selection = { skillIds: "invalid", connectorIds: [] };
  await expect(store.get("tenant", "alice")).rejects.toBeInstanceOf(ZodError);
  await expect(store.save("tenant", "alice", { selection: null, version: 0 }, available)).rejects.toBeInstanceOf(ZodError);
  expect(db.queries.some(({ text }) => text.includes("INSERT INTO audit_events"))).toBe(false);
});

test("does not commit a saved default when its audit event fails", async () => {
  const { state, db, store } = fixture();
  state.failAudit = true;
  await expect(store.save("tenant", "alice", { selection: available, version: 0 }, available))
    .rejects.toThrow("audit unavailable");
  expect(db.queries.some(({ text }) => text === "ROLLBACK")).toBe(true);
  expect(db.queries.some(({ text }) => text === "COMMIT")).toBe(false);
});
