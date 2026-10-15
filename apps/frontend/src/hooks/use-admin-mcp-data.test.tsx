// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, type QueryClientConfig } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AdminMcpServer } from "@cogniplane/shared-types";
import type { ReactNode } from "react";

import { listAdminMcpServers, saveAdminMcpConnection, setInheritedAdminMcpAudience } from "../lib/admin-api";
import { queryKeys } from "../lib/query-keys";
import { useAdminMcpData } from "./use-admin-mcp-data";

vi.mock("../lib/admin-api", () => ({
  listAdminMcpServers: vi.fn(), saveAdminMcpConnection: vi.fn(), setInheritedAdminMcpAudience: vi.fn()
}));

function server(serverId: string): AdminMcpServer {
  return {
    serverId, serverName: serverId, description: null, transportKind: "http", mode: "managed",
    routePath: `/mcp/${serverId}`, upstreamUrl: null, upstreamAuthType: "none", upstreamAuthName: null,
    upstreamAuthConfigured: false, version: 1, configHash: "h", enabled: true, isPublished: true,
    createdBy: "u1", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z"
  };
}

const input = {
  serverId: "docs", serverName: "Docs", description: null, mode: "managed" as const, routePath: "/mcp/docs",
  upstreamUrl: null, upstreamAuthType: "none" as const, credentialScope: "organization" as const,
  upstreamAuthName: null, audience: "members" as const
};

const clients: QueryClient[] = [];
beforeEach(() => {
  vi.mocked(listAdminMcpServers).mockResolvedValue([server("docs"), server("search")]);
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.resetAllMocks();
});

function renderMcp(options: QueryClientConfig = { defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }) {
  const client = new QueryClient(options);
  clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { ...renderHook(useAdminMcpData, { wrapper }), client };
}

async function renderLoaded() {
  const hook = renderMcp();
  await waitFor(() => expect(hook.result.current.loaded).toBe(true));
  return hook;
}

it("starts loading, then returns the servers", async () => {
  const hook = renderMcp();
  expect(hook.result.current).toMatchObject({ loading: true, loaded: false, mcpServers: [] });

  await waitFor(() => expect(hook.result.current.loaded).toBe(true));
  expect(hook.result.current.mcpServers.map((s) => s.serverId)).toEqual(["docs", "search"]);
  expect(hook.result.current).toMatchObject({ loading: false, busyKey: null, loadError: null, saveError: null });
  expect(hook.result.current.listGeneration).toBeGreaterThan(0);
});

it("shows the load fallback and reloads on request", async () => {
  vi.mocked(listAdminMcpServers).mockRejectedValueOnce("offline");
  const { result } = renderMcp();

  await waitFor(() => expect(result.current.loadError).toBe("Failed to load MCP connections."));

  await act(async () => { await result.current.reload(); });
  await waitFor(() => expect(result.current.loadError).toBeNull());
  expect(result.current.mcpServers).toHaveLength(2);
});

it("saves a connection, marks the page busy, and refreshes everything that depends on it", async () => {
  let finish!: () => void;
  vi.mocked(saveAdminMcpConnection).mockReturnValue(new Promise((resolve) => { finish = () => resolve(server("docs")); }));
  const { result, client } = await renderLoaded();
  const invalidate = vi.spyOn(client, "invalidateQueries");

  let saving!: Promise<void>;
  act(() => { saving = result.current.handleSubmit(input, "docs"); });
  await waitFor(() => expect(result.current.busyKey).toBe("mcp"));
  expect(saveAdminMcpConnection).toHaveBeenCalledWith(input, "docs");
  expect(invalidate).not.toHaveBeenCalled();

  await act(async () => { finish(); await saving; });
  await waitFor(() => expect(result.current.busyKey).toBeNull());
  const refreshed = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
  expect(refreshed).toEqual([
    queryKeys.admin.mcpServers(), queryKeys.admin.tenantSettings(),
    queryKeys.admin.runtimeConfig(), queryKeys.admin.runtimeSessions()
  ]);
});

it("rejects a failed save so the form stays open, shows the error, and still refreshes", async () => {
  vi.mocked(saveAdminMcpConnection).mockRejectedValue(new Error("Route path is taken."));
  const { result } = await renderLoaded();

  await act(async () => {
    await expect(result.current.handleSubmit(input, null)).rejects.toThrow("Route path is taken.");
  });

  await waitFor(() => expect(result.current.saveError).toBe("Route path is taken."));
  // Another admin may have changed the connection, so a failure reloads it too.
  await waitFor(() => expect(listAdminMcpServers).toHaveBeenCalledTimes(2));
});

it("marks the page busy while an audience change runs", async () => {
  let finish!: () => void;
  vi.mocked(setInheritedAdminMcpAudience).mockReturnValue(new Promise((resolve) => { finish = () => resolve(server("search")); }));
  const { result } = await renderLoaded();

  let changing!: Promise<void>;
  act(() => { changing = result.current.handleSetInheritedAudience("search", "members"); });
  await waitFor(() => expect(result.current.busyKey).toBe("mcp"));

  await act(async () => { finish(); await changing; });
  await waitFor(() => expect(result.current.busyKey).toBeNull());
});

it("sets the audience of an inherited server and shows the fallback when that fails", async () => {
  vi.mocked(setInheritedAdminMcpAudience).mockRejectedValue("offline");
  const { result } = await renderLoaded();

  await act(async () => {
    await result.current.handleSetInheritedAudience("search", "test_users").catch(() => undefined);
  });

  expect(setInheritedAdminMcpAudience).toHaveBeenCalledWith("search", "test_users");
  await waitFor(() => expect(result.current.saveError).toBe("Failed to save MCP availability."));
});

it("clears a failed connection save once an audience change succeeds", async () => {
  vi.mocked(saveAdminMcpConnection).mockRejectedValue(new Error("Route path is taken."));
  vi.mocked(setInheritedAdminMcpAudience).mockResolvedValue(server("search"));
  const { result } = await renderLoaded();

  await act(async () => { await result.current.handleSubmit(input, null).catch(() => undefined); });
  await waitFor(() => expect(result.current.saveError).toBe("Route path is taken."));

  await act(async () => { await result.current.handleSetInheritedAudience("search", "members"); });

  await waitFor(() => expect(result.current.saveError).toBeNull());
});

it("clears a failed audience change once a connection save succeeds", async () => {
  vi.mocked(setInheritedAdminMcpAudience).mockRejectedValue(new Error("Server is not inherited."));
  vi.mocked(saveAdminMcpConnection).mockResolvedValue(server("docs"));
  const { result } = await renderLoaded();

  await act(async () => { await result.current.handleSetInheritedAudience("search", "members").catch(() => undefined); });
  await waitFor(() => expect(result.current.saveError).toBe("Server is not inherited."));

  await act(async () => { await result.current.handleSubmit(input, "docs"); });

  await waitFor(() => expect(result.current.saveError).toBeNull());
});

it("does not mark the list loaded while the first load is retrying, or after it fails", async () => {
  let failRetry!: () => void;
  vi.mocked(listAdminMcpServers)
    .mockRejectedValueOnce("offline")
    .mockReturnValueOnce(new Promise((_, reject) => { failRetry = () => reject("offline"); }));
  const { result, client } = renderMcp({ defaultOptions: { queries: { retry: 1, retryDelay: 0 } } });

  // The retry is in flight.
  await waitFor(() => expect(listAdminMcpServers).toHaveBeenCalledTimes(2));
  expect(result.current).toMatchObject({ loading: true, loaded: false, mcpServers: [] });

  await act(async () => { failRetry(); });
  await waitFor(() => expect(client.getQueryState(queryKeys.admin.mcpServers())?.status).toBe("error"));
  expect(result.current).toMatchObject({ loading: false, loaded: false, mcpServers: [] });
});
