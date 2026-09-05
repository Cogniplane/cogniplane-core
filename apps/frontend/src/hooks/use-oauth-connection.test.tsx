// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  createGithubAuthorizationUrl: vi.fn(),
  createNotionAuthorizationUrl: vi.fn(),
  deleteGithubConnection: vi.fn(),
  deleteNotionConnection: vi.fn(),
  fetchGithubConnectionStatus: vi.fn(),
  fetchNotionConnectionStatus: vi.fn()
}));

vi.mock("../lib/settings-api", () => api);

import { useGithubConnection } from "./use-github-connection";
import { useNotionConnection } from "./use-notion-connection";

function renderConnection<T>(hook: () => T) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return { ...renderHook(hook, { wrapper }), queryClient };
}

function renderTestConnection(hook: typeof useGithubConnection | typeof useNotionConnection) {
  return renderConnection(() => {
    const connection = hook();
    return {
      ...connection,
      status: connection.status ? { configured: connection.status.configured } : null
    };
  });
}

let navigatedTo: string | null;

beforeEach(() => {
  navigatedTo = null;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      set href(value: string) {
        navigatedTo = value;
      },
      get href() {
        return navigatedTo ?? "http://localhost:3000/settings";
      }
    }
  });
  api.fetchGithubConnectionStatus.mockResolvedValue({
    configured: true,
    userConnection: null,
    tenantEnabled: true
  });
  api.fetchNotionConnectionStatus.mockResolvedValue({
    configured: true,
    userConnection: null,
    tenantEnabled: true
  });
  api.deleteGithubConnection.mockResolvedValue(undefined);
  api.deleteNotionConnection.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe.each([
  {
    provider: "GitHub",
    hook: useGithubConnection,
    fetchStatus: api.fetchGithubConnectionStatus,
    authorize: api.createGithubAuthorizationUrl,
    disconnect: api.deleteGithubConnection,
    queryKey: ["settings", "github"],
    connectFallback: "Failed to start GitHub authorization.",
    disconnectFallback: "Failed to disconnect GitHub."
  },
  {
    provider: "Notion",
    hook: useNotionConnection,
    fetchStatus: api.fetchNotionConnectionStatus,
    authorize: api.createNotionAuthorizationUrl,
    disconnect: api.deleteNotionConnection,
    queryKey: ["settings", "notion"],
    connectFallback: "Failed to start Notion authorization.",
    disconnectFallback: "Failed to disconnect Notion account."
  }
])("$provider OAuth connection", (testCase) => {
  it("keeps its provider status in a distinct query cache entry", async () => {
    const { result, queryClient } = renderTestConnection(testCase.hook);

    await waitFor(() => expect(result.current.status?.configured).toBe(true));

    expect(testCase.fetchStatus).toHaveBeenCalledOnce();
    expect(queryClient.getQueryData<{ configured: boolean }>(testCase.queryKey)?.configured).toBe(
      result.current.status?.configured
    );
  });

  it("recovers from a status load failure when reloaded", async () => {
    testCase.fetchStatus.mockRejectedValueOnce("unavailable");
    const { result } = renderTestConnection(testCase.hook);

    await waitFor(() => expect(result.current.error).toContain("Failed to load"));
    await act(async () => {
      await result.current.reload();
    });

    await waitFor(() => expect(result.current.status?.configured).toBe(true));
    expect(result.current.error).toBeNull();
  });

  it("stays busy through redirect and recovers after a failed connect", async () => {
    testCase.authorize
      .mockRejectedValueOnce("unavailable")
      .mockResolvedValueOnce(`https://${testCase.provider.toLowerCase()}.example/authorize`);
    const { result } = renderTestConnection(testCase.hook);
    await waitFor(() => expect(result.current.status).not.toBeNull());

    await act(async () => result.current.connect());
    expect(result.current.error).toBe(testCase.connectFallback);
    expect(result.current.busyKey).toBeNull();

    await act(async () => result.current.connect());
    expect(result.current.error).toBeNull();
    expect(result.current.busyKey).toBe("connect");
    expect(navigatedTo).toContain("/authorize");
  });

  it("reports a failed disconnect, then clears the error and invalidates after retry", async () => {
    testCase.disconnect.mockRejectedValueOnce("unavailable").mockResolvedValueOnce(undefined);
    const { result } = renderTestConnection(testCase.hook);
    await waitFor(() => expect(result.current.status).not.toBeNull());

    act(() => result.current.disconnect());
    await waitFor(() => expect(result.current.error).toBe(testCase.disconnectFallback));
    expect(result.current.busyKey).toBeNull();

    act(() => result.current.disconnect());
    await waitFor(() => expect(result.current.error).toBeNull());
    await waitFor(() => expect(testCase.fetchStatus).toHaveBeenCalledTimes(2));
  });
});
