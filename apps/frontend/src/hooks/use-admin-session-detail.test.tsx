// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AdminSessionDetailResponse } from "@cogniplane/shared-types";
import type { ReactNode } from "react";

import { getAdminSessionDetail } from "../lib/admin-api";
import { ApiError } from "../lib/api-client";
import { useAdminSessionDetailData } from "./use-admin-session-detail";

vi.mock("../lib/admin-api", () => ({ getAdminSessionDetail: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const detail = { overview: { sessionId: "s1" } } as unknown as AdminSessionDetailResponse;

/** The error request() throws for a JSON error body. */
function apiError(status: number, body: { error: string; message?: string }, path = "/admin/sessions/s1") {
  return new ApiError({ status, code: body.error, method: "GET", path, message: body.message ?? body.error });
}

function renderDetail(sessionId: string | null) {
  // retryDelay 0 keeps the two retries of a transient error fast.
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(() => useAdminSessionDetailData(sessionId), { wrapper });
}

it("returns the detail of a loaded session", async () => {
  vi.mocked(getAdminSessionDetail).mockResolvedValue(detail);
  const { result } = renderDetail("s1");

  await waitFor(() => expect(result.current.detail).toBe(detail));
  expect(result.current).toMatchObject({ error: null, available: true, isNotFound: false, isLoading: false });
});

it("does not request anything without a session id", () => {
  const { result } = renderDetail(null);

  // A disabled query does not load. Without `enabled`, it would run and fail.
  expect(result.current.isLoading).toBe(false);
  expect(getAdminSessionDetail).not.toHaveBeenCalled();
  expect(result.current.detail).toBeNull();
});

it("reports a missing session once, without retries or an error message", async () => {
  vi.mocked(getAdminSessionDetail).mockRejectedValue(apiError(404, { error: "session_not_found" }));
  const { result } = renderDetail("s1");

  await waitFor(() => expect(result.current.isNotFound).toBe(true));
  expect(result.current).toMatchObject({ detail: null, error: null, available: true });
  expect(getAdminSessionDetail).toHaveBeenCalledTimes(1);
});

it.each([
  // The current backend answers an unknown route with its own 404 body.
  ["the current backend", { error: "not_found" }],
  // Backends before 2026-06-13 sent Fastify's default body.
  ["an older backend", { error: "Not Found", message: "Route GET:/admin/sessions/s1 not found" }]
])("says session review is unavailable when %s has no such route", async (_backend, body) => {
  vi.mocked(getAdminSessionDetail).mockRejectedValue(apiError(404, body));
  const { result } = renderDetail("s1");

  await waitFor(() => expect(result.current.available).toBe(false));
  expect(result.current).toMatchObject({
    detail: null, isNotFound: false, error: "Session review is not available on this deployment yet."
  });
});

it("retries a failed load twice, then shows the server's message", async () => {
  vi.mocked(getAdminSessionDetail).mockRejectedValue(apiError(500, { error: "internal", message: "Database is busy." }));
  const { result } = renderDetail("s1");

  await waitFor(() => expect(result.current.error).toBe("Database is busy."));
  expect(getAdminSessionDetail).toHaveBeenCalledTimes(3);
  expect(result.current.available).toBe(true);
});
