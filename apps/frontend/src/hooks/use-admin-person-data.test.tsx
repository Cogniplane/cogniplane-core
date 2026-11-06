// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

const clients: QueryClient[] = [];
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.useFakeTimers();
  api.listAdminSessions.mockResolvedValue({ items: [] });
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
  vi.useRealTimers();
  vi.resetAllMocks();
});

const at = "2026-10-26T10:00:00.000Z";
const email = (status: NonNullable<AdminUser["linkEmail"]>["status"]) => ({
  purpose: "account_setup" as const, status, updatedAt: at, error: status === "failed" ? "EENVELOPE" : null
});

it.each([
  ["queued", "sent"],
  ["queued", "failed"],
  ["queued", "expired"],
  ["sending", "sent"],
  ["sending", "failed"],
  ["sending", "expired"]
] as const)("polls a %s email and stops after it becomes %s", async (pending, terminal) => {
  api.listAdminUsers
    .mockResolvedValueOnce([dana(email(pending))])
    .mockResolvedValue([dana(email(terminal))]);

  const { result } = renderHook(() => useAdminPersonData("dana"), { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(result.current.person?.linkEmail?.status).toBe(pending);

  await act(async () => { await vi.advanceTimersByTimeAsync(LINK_EMAIL_POLL_MS); });
  expect(result.current.person?.linkEmail?.status).toBe(terminal);

  await act(async () => { await vi.advanceTimersByTimeAsync(LINK_EMAIL_POLL_MS * 3); });
  expect(api.listAdminUsers).toHaveBeenCalledTimes(2);
});

it("does not poll another person's queued email", async () => {
  api.listAdminUsers.mockResolvedValue([
    { ...dana(email("queued")), userId: "fox", email: "fox@example.test" },
    dana(email("sent"))
  ]);

  const { result } = renderHook(() => useAdminPersonData("dana"), { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(result.current.person?.userId).toBe("dana");
  expect(result.current.person?.linkEmail?.status).toBe("sent");

  await act(async () => { await vi.advanceTimersByTimeAsync(LINK_EMAIL_POLL_MS * 3); });
  expect(api.listAdminUsers).toHaveBeenCalledTimes(1);
});
