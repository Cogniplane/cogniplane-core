// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PolicyRule, PolicyRuleInput } from "@cogniplane/shared-types";
import type { ReactNode } from "react";

import * as api from "../lib/admin-api";
import { queryKeys } from "../lib/query-keys";
import { usePolicyData } from "./use-policy-data";

vi.mock("../lib/admin-api", () => ({
  createPolicyRule: vi.fn(), deletePolicyRule: vi.fn(), getPolicyDecision: vi.fn(),
  getPolicyMonitorSummary: vi.fn(), listPolicyDecisions: vi.fn(), listPolicyLintWarnings: vi.fn(),
  listPolicyRules: vi.fn(), reorderPolicyRules: vi.fn(), simulatePolicy: vi.fn(), updatePolicyRule: vi.fn()
}));
vi.mock("next/navigation", () => ({ usePathname: vi.fn(), useRouter: vi.fn(), useSearchParams: vi.fn() }));

const rules = [{ ruleId: "a" }, { ruleId: "b" }, { ruleId: "c" }] as PolicyRule[];
const input = { name: "Block secrets" } as PolicyRuleInput;

const clients: QueryClient[] = [];
beforeEach(() => {
  vi.mocked(api.listPolicyRules).mockResolvedValue(rules);
  vi.mocked(api.listPolicyLintWarnings).mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.resetAllMocks();
});

async function renderLoaded() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const hook = renderHook(usePolicyData, { wrapper });
  await waitFor(() => expect(hook.result.current.rules).toHaveLength(3));
  return { ...hook, client };
}

const ids = (list: PolicyRule[]) => list.map((rule) => rule.ruleId);

it("creates a rule without an id, updates one with an id, and reloads rules and lint", async () => {
  vi.mocked(api.createPolicyRule).mockResolvedValue(rules[0]!);
  vi.mocked(api.updatePolicyRule).mockResolvedValue(rules[1]!);
  const { result } = await renderLoaded();

  await act(async () => { expect(await result.current.saveRule(null, input)).toBe(true); });
  await act(async () => { expect(await result.current.saveRule("b", input)).toBe(true); });

  expect(api.createPolicyRule).toHaveBeenCalledWith(input);
  expect(api.updatePolicyRule).toHaveBeenCalledWith("b", input);
  await waitFor(() => {
    expect(api.listPolicyRules).toHaveBeenCalledTimes(3);
    expect(api.listPolicyLintWarnings).toHaveBeenCalledTimes(3);
  });
});

it("returns false from a failed save and shows the server message", async () => {
  vi.mocked(api.createPolicyRule).mockRejectedValue(new Error("Rule name is taken."));
  const { result } = await renderLoaded();

  await act(async () => { expect(await result.current.saveRule(null, input)).toBe(false); });

  await waitFor(() => expect(result.current.error).toBe("Rule name is taken."));
});

it("shows the latest action's failure with its own fallback, and recovers on retry", async () => {
  vi.mocked(api.createPolicyRule).mockRejectedValue("");
  let rejectDelete!: (error: Error) => void;
  vi.mocked(api.deletePolicyRule)
    .mockReturnValueOnce(new Promise((_, reject) => { rejectDelete = reject; }))
    .mockResolvedValueOnce(undefined as never);
  const { result } = await renderLoaded();

  await act(async () => { await result.current.saveRule(null, input); });
  await waitFor(() => expect(result.current.error).toBe("Failed to save policy rule."));

  act(() => { void result.current.deleteRule("b"); });
  await waitFor(() => expect(result.current.busyKey).toBe("delete-b"));
  expect(result.current.error).toBeNull();

  await act(async () => { rejectDelete(new Error("Rule is in use.")); });
  await waitFor(() => expect(result.current.error).toBe("Rule is in use."));

  act(() => { void result.current.deleteRule("b"); });
  await waitFor(() => expect(result.current.busyKey).toBeNull());
  expect(result.current.error).toBeNull();
});

it("guards all rule actions synchronously while a save is pending", async () => {
  let resolveSave!: (rule: PolicyRule) => void;
  vi.mocked(api.createPolicyRule).mockReturnValue(new Promise(resolve => { resolveSave = resolve; }));
  const { result } = await renderLoaded();
  let saved!: Promise<boolean>;
  act(() => {
    saved = result.current.saveRule(null, input);
    void result.current.saveRule(null, input);
    void result.current.deleteRule("b");
    void result.current.reorderRules(["b", "a", "c"]);
  });
  await waitFor(() => expect(api.createPolicyRule).toHaveBeenCalledTimes(1));
  expect(api.deletePolicyRule).not.toHaveBeenCalled();
  expect(api.reorderPolicyRules).not.toHaveBeenCalled();
  await act(async () => { resolveSave(rules[0]!); await saved; });
});

it("shows the load fallback when the rules fail to load without an Error", async () => {
  vi.mocked(api.listPolicyRules).mockRejectedValue("offline");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result } = renderHook(usePolicyData, { wrapper });

  await waitFor(() => expect(result.current.error).toBe("Failed to load Policy Center."));
});

it("names the rule being deleted in busyKey", async () => {
  vi.mocked(api.deletePolicyRule).mockReturnValue(new Promise(() => {}));
  const { result } = await renderLoaded();

  act(() => { void result.current.deleteRule("b"); });

  await waitFor(() => expect(result.current.busyKey).toBe("delete-b"));
});

it("paints a reorder at once and rolls it back when the server rejects it", async () => {
  let reject!: (error: Error) => void;
  vi.mocked(api.reorderPolicyRules).mockReturnValue(new Promise((_, r) => { reject = r; }));
  const { result, client } = await renderLoaded();
  // The rollback must restore the cache, not wait for a refetch.
  vi.mocked(api.listPolicyRules).mockReturnValue(new Promise(() => {}));

  act(() => { void result.current.reorderRules(["c", "a", "b"]); });
  await waitFor(() => expect(ids(result.current.rules)).toEqual(["c", "a", "b"]));
  expect(result.current.busyKey).toBe("reorder");

  await act(async () => { reject(new Error("Order changed.")); });

  await waitFor(() => expect(ids(client.getQueryData<PolicyRule[]>(queryKeys.admin.policyRules())!)).toEqual(["a", "b", "c"]));
  await waitFor(() => expect(result.current.error).toBe("Order changed."));
});

it("keeps cached rules distinct from a failed first read and retries locally", async () => {
  const { result } = await renderLoaded();
  expect(result.current.rulesState).toBe("current");
  vi.mocked(api.listPolicyRules).mockRejectedValueOnce(new Error("Offline"));
  act(() => result.current.retryRules());
  await waitFor(() => expect(result.current.rulesState).toBe("stale"));
  expect(result.current.rules).toEqual(rules);
  act(() => result.current.retryRules());
  await waitFor(() => expect(result.current.rulesState).toBe("current"));
  expect(result.current.rulesError).toBeNull();
});

it("reports lint failure independently and retries only lint", async () => {
  vi.mocked(api.listPolicyLintWarnings).mockRejectedValueOnce(new Error("Lint offline"));
  const { result } = await renderLoaded();
  await waitFor(() => expect(result.current.lintState).toBe("unavailable"));
  expect(result.current.rulesState).toBe("current");
  expect(result.current.lintError).toBe("Lint offline");
  act(() => result.current.retryLint());
  await waitFor(() => expect(result.current.lintState).toBe("current"));
  expect(api.listPolicyRules).toHaveBeenCalledTimes(1);
});

it("distinguishes an initial pending read, an unavailable read and a successful zero", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  let rejectRead!: (error: Error) => void;
  vi.mocked(api.listPolicyRules).mockReturnValueOnce(new Promise((_, reject) => { rejectRead = reject; })).mockResolvedValue([]);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result } = renderHook(usePolicyData, { wrapper });
  expect(result.current.rulesState).toBe("loading");
  await act(async () => rejectRead(new Error("Read failed")));
  await waitFor(() => expect(result.current.rulesState).toBe("unavailable"));
  act(() => result.current.retryRules());
  await waitFor(() => expect(result.current.rulesState).toBe("current"));
  expect(result.current.rules).toEqual([]);
});

it("binds simulator failures to a run, blocks duplicates, and ignores a superseded completion", async () => {
  const { result } = await renderLoaded();
  let complete!: (value: Awaited<ReturnType<typeof api.simulatePolicy>>) => void;
  vi.mocked(api.simulatePolicy).mockReturnValueOnce(new Promise(resolve => { complete = resolve; }))
    .mockRejectedValueOnce(new Error("Test unavailable"))
    .mockResolvedValueOnce({ outcome: "allow", enforced: false, matchedRuleId: null, matchedRuleName: null, explanation: null });
  const request = { toolName: "sample_write", category: null, serverId: null, turnContext: "scheduled" as const };
  let older!: Promise<void>;
  act(() => { older = result.current.runSimulation(request); void result.current.runSimulation(request); });
  expect(api.simulatePolicy).toHaveBeenCalledTimes(1);
  act(() => result.current.clearSimulation());
  await act(async () => { await result.current.runSimulation({ ...request, toolName: "sample_read" }); });
  expect(result.current.simulationError).toBe("Test unavailable");
  await act(async () => { complete({ outcome: "block", enforced: false, matchedRuleId: "a", matchedRuleName: "Old rule", explanation: null }); await older; });
  expect(result.current.simulation).toBeNull();
  expect(result.current.simulationError).toBe("Test unavailable");
  await act(async () => { await result.current.runSimulation(request); });
  expect(result.current.simulationError).toBeNull();
  expect(result.current.simulation?.outcome).toBe("allow");
  expect(api.simulatePolicy).toHaveBeenLastCalledWith(request);
});
