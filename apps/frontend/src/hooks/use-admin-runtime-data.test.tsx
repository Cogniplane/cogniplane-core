// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, type QueryClientConfig } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AdminRuntimeConfig, RuntimeRolloutResponse, RuntimeSessionSummary } from "@cogniplane/shared-types";
import type { ReactNode } from "react";
import { getRuntimeConfig, listRuntimeSessions, rolloutRuntimeSessions } from "../lib/admin-api";
import { useAdminRuntimeData } from "./use-admin-runtime-data";
import AdminRuntimePage from "../app/admin/runtime/page";

vi.mock("../lib/admin-api", () => ({ getRuntimeConfig: vi.fn(), listRuntimeSessions: vi.fn(), rolloutRuntimeSessions: vi.fn() }));
const session: RuntimeSessionSummary = {
  sessionId: "session-r1", runtimeId: "r1", status: "active", healthStatus: "healthy", startedAt: null,
  lastActiveAt: null, updatedAt: "2026-10-01T10:00:00.000Z", runtimeProvider: "deep-agents",
  configSummary: { manifestHash: "m", configBundleHash: "c", runtimePolicy: { id: "default", version: 1, hash: "p" }, skillVersions: [], mcpServerVersions: [] }
};
const config: AdminRuntimeConfig = { e2bTemplateId: "tpl", platformProviders: ["anthropic"] };
const clients: QueryClient[] = [];
beforeEach(() => { vi.mocked(listRuntimeSessions).mockResolvedValue([session]); vi.mocked(getRuntimeConfig).mockResolvedValue(config); });
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear(); vi.resetAllMocks(); });
function setup(options: QueryClientConfig = { defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }) {
  const client = new QueryClient(options); clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}
function renderRuntime(options?: QueryClientConfig) { const env = setup(options); return { ...renderHook(useAdminRuntimeData, { wrapper: env.wrapper }), ...env }; }
async function loaded() { const hook = renderRuntime(); await waitFor(() => expect(hook.result.current.sessionsLoaded).toBe(true)); return hook; }

it("separates first-read pending from a successful empty result", async () => {
  let finish!: (sessions: RuntimeSessionSummary[]) => void;
  vi.mocked(listRuntimeSessions).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const { result } = renderRuntime();
  expect(result.current.sessionsLoaded).toBe(false);
  expect(result.current.sessionsLoading).toBe(true);
  await act(async () => finish([]));
  await waitFor(() => expect(result.current.sessionsLoaded).toBe(true));
  expect(result.current.runtimeSessions).toEqual([]);
  expect(result.current.sessionsLoading).toBe(false);
});
it("makes configuration failure independent, keeps sessions and supports a local retry", async () => {
  vi.mocked(getRuntimeConfig).mockRejectedValueOnce(new Error("config down"));
  const { result } = renderRuntime({ defaultOptions: { queries: { retry: 3, retryDelay: 0 } } });
  await waitFor(() => expect(result.current.configError).toBe("config down"));
  expect(result.current).toMatchObject({ runtimeSessions: [session], runtimeConfig: null, sessionsError: null });
  expect(getRuntimeConfig).toHaveBeenCalledTimes(1);
  act(() => result.current.onRetryConfig());
  await waitFor(() => expect(result.current.runtimeConfig).toEqual(config));
  expect(listRuntimeSessions).toHaveBeenCalledTimes(1);
});
it("keeps initial Reload mounted and focused across the real QueryClient error-to-pending transition", async () => {
  vi.mocked(listRuntimeSessions).mockRejectedValueOnce(new Error("list down"));
  const { wrapper } = setup(); render(<AdminRuntimePage />, { wrapper });
  await screen.findByRole("alert");
  let finish!: (sessions: RuntimeSessionSummary[]) => void;
  vi.mocked(listRuntimeSessions).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const retry = screen.getByRole("button", { name: "Reload records" }); retry.focus();
  fireEvent.click(retry); fireEvent.click(retry); fireEvent.keyDown(retry, { key: "Enter" });
  await waitFor(() => expect(retry.getAttribute("aria-busy")).toBe("true"));
  expect(document.activeElement).toBe(retry);
  expect(listRuntimeSessions).toHaveBeenCalledTimes(2);
  expect(screen.queryByText("0 recent records")).toBeNull();
  await act(async () => finish([session]));
  await screen.findByText("1 recent record");
  expect(document.activeElement).toBe(retry);
});
it("keeps confirmed records on a failed refresh", async () => {
  const { result } = await loaded();
  vi.mocked(listRuntimeSessions).mockRejectedValue(new Error("refresh down"));
  act(() => result.current.onRetrySessions());
  await waitFor(() => expect(result.current.sessionsError).toBe("refresh down"));
  expect(result.current.sessionsLoaded).toBe(true);
  expect(result.current.runtimeSessions).toEqual([session]);
});
it.each([["onDrainIdle", "drain_idle", "drain"], ["onRefreshIdle", "refresh_idle", "refresh"]] as const)("%s guards a same-tick burst and retains the actual affected session result", async (handler, action, busyKey) => {
  let finish!: (response: RuntimeRolloutResponse) => void;
  vi.mocked(rolloutRuntimeSessions).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const { result } = await loaded();
  act(() => { result.current[handler](); result.current[handler](); result.current.onDrainIdle(); result.current.onRefreshIdle(); });
  await waitFor(() => expect(rolloutRuntimeSessions).toHaveBeenCalledTimes(1));
  expect(rolloutRuntimeSessions).toHaveBeenCalledWith(action, expect.anything());
  await waitFor(() => expect(result.current.busyKey).toBe(busyKey));
  expect(listRuntimeSessions).toHaveBeenCalledTimes(1);
  const response = { action, affectedSessionIds: ["session-r1", "session-r2"] };
  await act(async () => finish(response));
  await waitFor(() => expect(result.current.rolloutResult).toEqual(response));
  await waitFor(() => expect(listRuntimeSessions).toHaveBeenCalledTimes(2));
  act(() => result.current.onPrepareRollout());
  await waitFor(() => expect(result.current.rolloutResult).toBeNull());
});
it("keeps rollout and list failures separate and allows retry after a failed mutation", async () => {
  vi.mocked(listRuntimeSessions).mockRejectedValue(new Error("list down"));
  vi.mocked(rolloutRuntimeSessions).mockRejectedValueOnce(new Error("reset down"));
  const { result } = renderRuntime();
  await waitFor(() => expect(result.current.sessionsError).toBe("list down"));
  act(() => result.current.onDrainIdle());
  await waitFor(() => expect(result.current.rolloutError).toBe("reset down"));
  expect(result.current.sessionsError).toBe("list down");
  vi.mocked(rolloutRuntimeSessions).mockResolvedValue({ action: "drain_idle", affectedSessionIds: [] });
  act(() => result.current.onDrainIdle());
  await waitFor(() => expect(result.current.rolloutResult?.affectedSessionIds).toEqual([]));
  expect(result.current.rolloutError).toBeNull();
});
