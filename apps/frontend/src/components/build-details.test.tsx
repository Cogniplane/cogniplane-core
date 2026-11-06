// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_URL, setAccessToken } from "../lib/api-client";
import { BuildDetails } from "./build-details";
const auth = vi.hoisted(() => ({ role: undefined as string | undefined }));
vi.mock("../lib/auth-context", () => ({ useAuth: () => ({ user: { role: auth.role } }) }));
afterEach(() => { cleanup(); auth.role = undefined; setAccessToken(null); vi.unstubAllGlobals(); });

describe("build details in help", () => {
  const DIAGNOSTICS = {
    status: "ok",
    uptimeSeconds: 120,
    version: { sha: "abcdef0123456789", buildDate: "2026-10-12T08:30:00Z" },
    runtimes: { activeRuntimeCount: 1, activeTurnCount: 0 }
  };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const sidebar = () => <BuildDetails />;
  const requested = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.map((call: unknown[]) => String(call[0]));

  it.each(["admin", "owner"])("shows the backend build to the %s role, from the authenticated diagnostics request", async (role) => {
    auth.role = role;
    setAccessToken("admin-token");
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => json(200, DIAGNOSTICS));
    vi.stubGlobal("fetch", fetchMock);
    render(sidebar());

    expect(await screen.findByText("be · abcdef0 · 2026-10-12")).toBeTruthy();
    expect(screen.getByText("be · abcdef0 · 2026-10-12").getAttribute("title"))
      .toBe("Backend: abcdef0123456789 · 2026-10-12T08:30:00Z");
    expect(requested(fetchMock)).toEqual([`${API_URL}/admin/diagnostics`]);
    const init = fetchMock.mock.calls[0]![1];
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer admin-token");
  });

  it.each(["member", undefined])("makes no diagnostics or health request for the %s role, and shows only the frontend build", async (role) => {
    auth.role = role;
    setAccessToken("member-token");
    const fetchMock = vi.fn(async () => json(200, DIAGNOSTICS));
    vi.stubGlobal("fetch", fetchMock);
    render(sidebar());

    expect(screen.getByText(/^fe · /)).toBeTruthy();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/^be · /)).toBeNull();
  });

  it.each([
    ["a forbidden response", () => json(403, { error: "forbidden" })],
    ["a network error", () => { throw new TypeError("Failed to fetch"); }],
    ["a body with no build", () => json(200, { status: "ok" })],
    ["a body that is not JSON", () => new Response("<html>Bad gateway</html>", { status: 200 })]
  ])("shows no backend build after %s", async (_name, reply) => {
    auth.role = "owner";
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", record);
    const fetchMock = vi.fn(async () => reply());
    vi.stubGlobal("fetch", fetchMock);
    render(sidebar());

    try {
      await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
      expect(screen.queryByText(/^be · /)).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByText(/^fe · /)).toBeTruthy();
      expect(unhandled).toEqual([]);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", record);
      errors.mockRestore();
    }
  });
});
