// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
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
