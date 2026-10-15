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

  act(() => result.current.deleteRule("b"));
  await waitFor(() => expect(result.current.busyKey).toBe("delete-b"));
  expect(result.current.error).toBeNull();

  await act(async () => { rejectDelete(new Error("Rule is in use.")); });
  await waitFor(() => expect(result.current.error).toBe("Rule is in use."));

  act(() => result.current.deleteRule("b"));
  await waitFor(() => expect(result.current.busyKey).toBeNull());
  expect(result.current.error).toBeNull();
});

it("does not let an older save that fails later replace a newer delete's result", async () => {
  let rejectSave!: (error: Error) => void;
  vi.mocked(api.createPolicyRule).mockReturnValue(new Promise((_, reject) => { rejectSave = reject; }));
  vi.mocked(api.deletePolicyRule).mockReturnValue(new Promise(() => {}));
  const { result, client } = await renderLoaded();

  let saved!: Promise<boolean>;
  act(() => { saved = result.current.saveRule(null, input); });
  act(() => result.current.deleteRule("b"));
  await act(async () => { rejectSave(new Error("Rule name is taken.")); expect(await saved).toBe(false); });

  await waitFor(() => expect(client.getMutationCache().getAll().filter((m) => m.state.status === "error")).toHaveLength(1));
  // TanStack Query delivers observer updates on a zero-delay timer.
  await act(() => new Promise<void>((resolve) => { setTimeout(resolve, 0); }));
  expect(result.current.error).toBeNull();
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

  act(() => result.current.deleteRule("b"));

  await waitFor(() => expect(result.current.busyKey).toBe("delete-b"));
});

it("paints a reorder at once and rolls it back when the server rejects it", async () => {
  let reject!: (error: Error) => void;
  vi.mocked(api.reorderPolicyRules).mockReturnValue(new Promise((_, r) => { reject = r; }));
  const { result, client } = await renderLoaded();
  // The rollback must restore the cache, not wait for a refetch.
  vi.mocked(api.listPolicyRules).mockReturnValue(new Promise(() => {}));

  act(() => result.current.reorderRules(["c", "a", "b"]));
  await waitFor(() => expect(ids(result.current.rules)).toEqual(["c", "a", "b"]));
  expect(result.current.busyKey).toBe("reorder");

  await act(async () => { reject(new Error("Order changed.")); });

  await waitFor(() => expect(ids(client.getQueryData<PolicyRule[]>(queryKeys.admin.policyRules())!)).toEqual(["a", "b", "c"]));
  await waitFor(() => expect(result.current.error).toBe("Order changed."));
});
