// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AdminIntegrationView } from "@cogniplane/shared-types";
import type { ReactNode } from "react";

import * as api from "../lib/integrations-api";
import { queryKeys } from "../lib/query-keys";
import { useAdminIntegrations } from "./use-integrations";

vi.mock("../lib/integrations-api", () => ({
  fetchAdminIntegrations: vi.fn(), updateIntegration: vi.fn(), deleteIntegrationConfig: vi.fn()
}));

const integration: AdminIntegrationView = {
  id: "test", name: "Test", description: "", longDescription: "", logoSlug: "test",
  status: "available", category: "test", readToolIds: [], writeToolIds: [],
  configMode: "none", readsEnabled: false, writesEnabled: false, hasConfig: false,
  configSummary: {}, updatedAt: null, updatedBy: null, platformConfigured: false,
  platformConfigMessage: null
};
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.resetAllMocks();
});

function RuntimeStatus() {
  const { data } = useQuery({ queryKey: queryKeys.admin.runtimeSessions(), queryFn: async () => "Terminated" });
  return <p>{data}</p>;
}

it.each(["update", "clearConfig"] as const)("refreshes cached runtime sessions after integration %s", async (action) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000, gcTime: 0 } } });
  clients.push(client);
  client.setQueryData(queryKeys.admin.integrations(), [integration]);
  client.setQueryData(queryKeys.admin.runtimeSessions(), "Running");
  vi.mocked(api.updateIntegration).mockResolvedValue(integration);
  vi.mocked(api.deleteIntegrationConfig).mockResolvedValue(integration);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result } = renderHook(useAdminIntegrations, { wrapper });
  await act(async () => {
    if (action === "update") await result.current.update("test", { readsEnabled: true });
    else await result.current.clearConfig("test");
  });
  render(<RuntimeStatus />, { wrapper });
  expect(await screen.findByText("Terminated")).toBeTruthy();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setupRows() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  clients.push(client);
  const rows = [integration, { ...integration, id: "other", name: "Other" }];
  client.setQueryData(queryKeys.admin.integrations(), rows);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, rows, ...renderHook(useAdminIntegrations, { wrapper }) };
}

it("retains both pending rows and rolls back only the failed row after another row succeeds", async () => {
  const a = deferred<AdminIntegrationView>();
  const b = deferred<AdminIntegrationView>();
  vi.mocked(api.updateIntegration).mockImplementation(id => id === "test" ? a.promise : b.promise);
  const { result, rows } = setupRows();
  let first!: Promise<boolean>;
  let second!: Promise<boolean>;
  await act(async () => {
    first = result.current.update("test", { readsEnabled: true });
    second = result.current.update("other", { writesEnabled: true });
  });
  expect(result.current.pending).toEqual({ test: "toggle", other: "toggle" });
  await act(async () => { b.resolve({ ...rows[1]!, writesEnabled: true }); await second; });
  expect(result.current.pending).toEqual({ test: "toggle" });
  await act(async () => { a.reject(new Error("First row failed")); await first; });
  expect(result.current.integrations.map(row => [row.id, row.readsEnabled, row.writesEnabled])).toEqual([["test", false, false], ["other", false, true]]);
  expect(result.current.errors.test?.message).toBe("First row failed");
  expect(result.current.errors.other).toBeUndefined();
});

it("rejects same-row duplicate save, toggle and clear synchronously, and keeps failures local", async () => {
  const save = deferred<AdminIntegrationView>();
  const clear = deferred<AdminIntegrationView>();
  vi.mocked(api.updateIntegration).mockReturnValue(save.promise);
  vi.mocked(api.deleteIntegrationConfig).mockReturnValue(clear.promise);
  const { result } = setupRows();
  let first!: Promise<boolean>;
  let other!: Promise<boolean>;
  await act(async () => {
    first = result.current.update("test", { config: { clientId: "fictional" } });
    expect(result.current.isPending("test")).toBe(true);
    expect(await result.current.update("test", { readsEnabled: true })).toBe(false);
    expect(await result.current.clearConfig("test")).toBe(false);
    other = result.current.clearConfig("other");
  });
  expect(api.updateIntegration).toHaveBeenCalledTimes(1);
  expect(api.deleteIntegrationConfig).toHaveBeenCalledTimes(1);
  await act(async () => {
    save.reject(new Error("Save failed"));
    clear.reject(new Error("Clear failed"));
    await Promise.all([first, other]);
  });
  expect(result.current.errors).toEqual({ test: { operation: "save", message: "Save failed" }, other: { operation: "clear", message: "Clear failed" } });
  expect(result.current.pending).toEqual({});
});

it("keeps an optimistic row during a background read and cancels an older read before applying success", async () => {
  const mutation = deferred<AdminIntegrationView>();
  const read = deferred<AdminIntegrationView[]>();
  vi.mocked(api.updateIntegration).mockReturnValue(mutation.promise);
  const { client, result, rows } = setupRows();
  vi.mocked(api.fetchAdminIntegrations).mockResolvedValue(rows);
  let update!: Promise<boolean>;
  await act(async () => { update = result.current.update("test", { readsEnabled: true }); });
  await waitFor(() => expect(api.updateIntegration).toHaveBeenCalledTimes(1));
  await act(async () => { await client.refetchQueries({ queryKey: queryKeys.admin.integrations() }); });
  expect(client.getQueryData<AdminIntegrationView[]>(queryKeys.admin.integrations())?.[0]?.readsEnabled).toBe(true);
  await waitFor(() => expect(result.current.integrations[0]?.readsEnabled).toBe(true));
  vi.mocked(api.fetchAdminIntegrations).mockReturnValue(read.promise);
  let refresh!: Promise<void>;
  await act(async () => { refresh = client.refetchQueries({ queryKey: queryKeys.admin.integrations() }); });
  await act(async () => { mutation.resolve({ ...rows[0]!, readsEnabled: true }); await update; });
  await act(async () => { read.resolve(rows); await refresh; });
  expect(result.current.integrations[0]?.readsEnabled).toBe(true);
});
