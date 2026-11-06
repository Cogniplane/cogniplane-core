// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { AdminUser } from "@cogniplane/shared-types";

const api = vi.hoisted(() => ({ listAdminUsers: vi.fn(), listAdminSessions: vi.fn() }));
vi.mock("../lib/admin-api", () => api);
vi.mock("../lib/token-usage-api", () => ({ fetchMemberMonthUsage: vi.fn(async () => ({})) }));

import { LINK_EMAIL_POLL_MS, useAdminPersonData } from "./use-admin-person-data";

function dana(linkEmail: AdminUser["linkEmail"]): AdminUser {
  return {
    userId: "dana", tenantId: "t", email: "dana@example.test", displayName: "Dana", role: "member", isBetaTester: false,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", accountStatus: "pending_setup", linkEmail
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

it("reads the list again while the person's link email waits, and stops when it is done", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const at = "2026-10-26T10:00:00.000Z";
  api.listAdminSessions.mockResolvedValue({ items: [] });
  api.listAdminUsers
    .mockResolvedValueOnce([dana({ purpose: "account_setup", status: "queued", updatedAt: at, error: null })])
    .mockResolvedValueOnce([dana({ purpose: "account_setup", status: "failed", updatedAt: at, error: "EENVELOPE 550" })]);

  const { result } = renderHook(() => useAdminPersonData("dana"), { wrapper });
  await waitFor(() => expect(result.current.person?.linkEmail?.status).toBe("queued"));

  await act(async () => { await vi.advanceTimersByTimeAsync(LINK_EMAIL_POLL_MS); });
  await waitFor(() => expect(result.current.person?.linkEmail?.status).toBe("failed"));

  await act(async () => { await vi.advanceTimersByTimeAsync(LINK_EMAIL_POLL_MS * 3); });
  expect(api.listAdminUsers).toHaveBeenCalledTimes(2);
});
