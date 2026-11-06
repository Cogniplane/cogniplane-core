// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ user: null as Record<string, unknown> | null }));
vi.mock("../lib/auth-context", () => ({ useAuth: () => ({ user: auth.user }) }));
vi.mock("../lib/integrations-api", () => ({ fetchIntegrationsAvailability: vi.fn(async () => []) }));
vi.mock("../lib/settings-api", () => ({ fetchJiraConnectionStatus: vi.fn(async () => ({ accounts: [] })) }));

import { useEnabledSettingsSections } from "./use-enabled-settings-sections";

const clients: QueryClient[] = [];
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
  auth.user = null;
});

describe("useEnabledSettingsSections", () => {
  it.each([
    ["local", true],
    ["workos", false],
    [undefined, false]
  ])("shows Sign-in & security for loginType %s: %s", async (loginType, shown) => {
    auth.user = { userId: "u", tenantId: "t", role: "member", loginType };
    const { result } = renderHook(() => useEnabledSettingsSections(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.liveSections.some((section) => section.id === "security")).toBe(shown);
    expect(result.current.navigationItems.some((item) => item.id === "security")).toBe(shown);
  });
});
