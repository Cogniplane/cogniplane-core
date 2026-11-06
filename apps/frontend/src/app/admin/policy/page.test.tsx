// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import AdminPolicyRoute from "./page";

const cards = vi.hoisted(() => ({
  rules: vi.fn((props: Record<string, unknown>) => props.children as ReactNode),
  simulator: vi.fn((_props: Record<string, unknown>) => null)
}));
vi.mock("../../../components/admin/policy/admin-policy-rules-card", () => ({ AdminPolicyRulesCard: cards.rules }));
vi.mock("../../../components/admin/policy/admin-policy-simulator", () => ({ AdminPolicySimulator: cards.simulator }));
const state = vi.hoisted(() => ({ rulesState: "loading", rulesError: null as string | null, lintState: "checking", lintError: null as string | null, simulationError: null as string | null }));
vi.mock("../../../hooks/use-policy-data", () => ({
  usePolicyData: () => ({ ...state, rules: [], lintWarnings: [], busyKey: null, refreshing: false, retryRules: vi.fn(), retryLint: vi.fn(), saveRule: vi.fn(), deleteRule: vi.fn(), reorderRules: vi.fn(), simulation: null, simulating: false, runSimulation: vi.fn(), clearSimulation: vi.fn() }),
  useDecisionsData: () => ({ decisions: [], filters: {} }),
  usePolicyMonitorSummary: () => ({})
}));
vi.mock("../../../hooks/use-tenant-settings", () => ({ useTenantSettings: () => ({ settings: null }) }));
vi.mock("../../../components/admin/history/history-widgets", () => ({ LastAdminChange: () => null }));
vi.mock("../../../components/admin/policy/admin-policy-enforcement", () => ({ AdminPolicyEnforcement: () => null }));
vi.mock("../../../components/admin/policy/admin-policy-decisions-card", () => ({ AdminPolicyDecisionsCard: () => null }));
afterEach(cleanup);

it.each([
  { rulesState: "loading", rulesError: null, lintState: "checking", lintError: null, simulationError: null },
  { rulesState: "unavailable", rulesError: "Read offline", lintState: "unavailable", lintError: "Warnings offline", simulationError: "Test offline" }
])("passes $rulesState rule, lint and simulator states to their cards", (next) => {
  Object.assign(state, next);
  render(<AdminPolicyRoute />);
  expect(cards.rules.mock.calls.at(-1)?.[0]).toMatchObject({
    rulesState: next.rulesState, rulesError: next.rulesError,
    lintState: next.lintState, lintError: next.lintError
  });
  expect(cards.simulator.mock.calls.at(-1)?.[0]).toMatchObject({ error: next.simulationError });
});
