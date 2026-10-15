// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, type QueryClientConfig } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AdminRuntimeConfig, RuntimeRolloutResponse, RuntimeSessionSummary } from "@cogniplane/shared-types";
import type { ReactNode } from "react";

import { getRuntimeConfig, listRuntimeSessions, rolloutRuntimeSessions } from "../lib/admin-api";
import { queryKeys } from "../lib/query-keys";
import { useAdminRuntimeData } from "./use-admin-runtime-data";

vi.mock("../lib/admin-api", () => ({ getRuntimeConfig: vi.fn(), listRuntimeSessions: vi.fn(), rolloutRuntimeSessions: vi.fn() }));

function session(runtimeId: string): RuntimeSessionSummary {
  return {
    sessionId: `session-${runtimeId}`, runtimeId, status: "active", healthStatus: "healthy", startedAt: null,
    lastActiveAt: null, updatedAt: "2026-10-01T10:00:00.000Z", runtimeProvider: "deep-agents",
    configSummary: {
      manifestHash: "m", configBundleHash: "c", runtimePolicy: { id: "default", version: 1, hash: "p" },
      skillVersions: [], mcpServerVersions: []
    }
  };
}
const sessions = [session("r1")];
const config: AdminRuntimeConfig = { e2bTemplateId: "tpl", platformProviders: ["anthropic"] };

const clients: QueryClient[] = [];
beforeEach(() => {
  vi.mocked(listRuntimeSessions).mockResolvedValue(sessions);
  vi.mocked(getRuntimeConfig).mockResolvedValue(config);
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.resetAllMocks();
});

function renderRuntime(options: QueryClientConfig = { defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }) {
  const client = new QueryClient(options);
  clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { ...renderHook(useAdminRuntimeData, { wrapper }), client };
}

async function renderLoaded() {
  const hook = renderRuntime();
  await waitFor(() => expect(hook.result.current.runtimeConfig).toEqual(config));
  return hook;
}

it("returns the runtime sessions and backend configuration", async () => {
  const { result } = await renderLoaded();

  expect(result.current).toMatchObject({ runtimeSessions: sessions, runtimeConfig: config, busyKey: null, error: null });
});

it("keeps the page usable when only the configuration fails, without retrying it", async () => {
  vi.mocked(getRuntimeConfig).mockRejectedValue(new Error("config down"));
  // Fast retries by default, so a missing `retry: false` would show as extra calls.
  const { result, client } = renderRuntime({ defaultOptions: { queries: { retry: 3, retryDelay: 0 } } });

  // The query reaches "error" only after its last retry.
  await waitFor(() => expect(client.getQueryState(queryKeys.admin.runtimeConfig())?.status).toBe("error"));
  expect(getRuntimeConfig).toHaveBeenCalledTimes(1);
  expect(result.current).toMatchObject({ runtimeSessions: sessions, runtimeConfig: null, error: null });
});

it.each([
  ["handleDrainIdle", "drain_idle", "drain"],
  ["handleRefreshIdle", "refresh_idle", "refresh"]
] as const)("%s marks its button busy and reloads the sessions when it is done", async (handler, mode, busyKey) => {
  let finish!: () => void;
  const response: RuntimeRolloutResponse = { action: mode, affectedSessionIds: ["r1"] };
  vi.mocked(rolloutRuntimeSessions).mockReturnValue(new Promise((resolve) => { finish = () => resolve(response); }));
  const { result } = await renderLoaded();
  const refreshed = [session("r2")];
  vi.mocked(listRuntimeSessions).mockResolvedValue(refreshed);

  act(() => result.current[handler]());
  await waitFor(() => expect(result.current.busyKey).toBe(busyKey));
  expect(rolloutRuntimeSessions).toHaveBeenCalledWith(mode);
  // Nothing reloads while the rollout runs.
  expect(listRuntimeSessions).toHaveBeenCalledTimes(1);

  await act(async () => { finish(); });
  await waitFor(() => expect(result.current.runtimeSessions).toEqual(refreshed));
  await waitFor(() => expect(result.current.busyKey).toBeNull());
});

it.each([
  ["handleDrainIdle", "Failed to drain runtimes."],
  ["handleRefreshIdle", "Failed to refresh runtimes."]
] as const)("names the failed rollout from %s, ahead of a load error", async (handler, message) => {
  vi.mocked(listRuntimeSessions).mockRejectedValue("offline");
  vi.mocked(rolloutRuntimeSessions).mockRejectedValue("offline");
  const { result } = await renderLoaded();
  await waitFor(() => expect(result.current.error).toBe("Failed to load runtime sessions."));

  act(() => result.current[handler]());

  await waitFor(() => expect(result.current.error).toBe(message));
});
