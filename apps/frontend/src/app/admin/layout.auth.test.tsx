// @vitest-environment jsdom
//
// The admin layout with the real AuthProvider and AuthGuard. Only the network
// and the data hooks of the page are stand-ins. A forged session hint cookie or
// forged role values must not open the admin shell. The role comes from the
// server's /auth/me answer.

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// The provider reads this at load. Dev-headers mode would invent an owner.
vi.hoisted(() => { delete process.env.NEXT_PUBLIC_DEV_USER_ID; });
const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/admin/overview", useRouter: () => router }));
vi.mock("../../hooks/use-organizations", () => ({ useOrganizations: () => [] }));
vi.mock("../../hooks/use-admin-overview-data", () => ({ useAdminOverviewData: () => ({ skillsCount: 2, mcpServersCount: 1 }) }));

import { setAccessToken } from "../../lib/api-client";
import { AuthProvider } from "../../lib/auth-context";
import AdminLayout from "./layout";

const HINT = "cogniplane_session_hint";
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const person = (role: "owner" | "admin" | "member") => ({
  userId: "u-1", email: "person@example.test", displayName: "Person", tenantId: "t-1", role
});

function stubAuthApi(refresh: () => Response, me?: () => Response) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path === "/auth/refresh") return refresh();
    if (path === "/auth/me" && me) return me();
    return json(404, { error: "unexpected_call", path });
  }));
}

function mount() {
  return render(
    <AuthProvider>
      <AdminLayout><p data-testid="admin-page">Admin page content</p></AdminLayout>
    </AuthProvider>
  );
}

const adminShell = () => screen.queryByRole("navigation", { name: "Admin sections" });

beforeEach(() => {
  setAccessToken(null);
  router.replace.mockClear();
  document.cookie = `${HINT}=1; Path=/`;
  document.cookie = "role=admin; Path=/";
  localStorage.setItem("role", "admin");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const name of [HINT, "role"]) document.cookie = `${name}=; Path=/; Max-Age=0`;
  localStorage.clear();
});

function expectNoAdminUi() {
  expect(adminShell()).toBeNull();
  expect(screen.queryByTestId("admin-page")).toBeNull();
  expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  expect(screen.queryByText(/Admin page content|Overview|Jump to/)).toBeNull();
}

it("shows no admin UI to a visitor with a forged hint and no session", async () => {
  stubAuthApi(() => json(401, { error: "invalid_refresh_token" }));
  mount();

  await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
  expectNoAdminUi();
});

it("shows only a loading state, and no admin UI, while the session check runs", async () => {
  let answer!: () => void;
  const pending = new Promise<Response>((resolve) => { answer = () => resolve(json(401, { error: "invalid_refresh_token" })); });
  vi.stubGlobal("fetch", vi.fn(async () => pending));
  mount();

  expect(await screen.findByText("Loading...")).toBeTruthy();
  expectNoAdminUi();
  answer();
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
  expectNoAdminUi();
});

it("shows no admin UI to a member, whatever the forged hint and role values say", async () => {
  stubAuthApi(() => json(200, { accessToken: "member-token" }), () => json(200, person("member")));
  mount();

  await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
  expect(router.replace).not.toHaveBeenCalledWith("/login");
  expectNoAdminUi();
});

it("shows no admin UI when the server refuses the token", async () => {
  stubAuthApi(() => json(200, { accessToken: "stale" }), () => json(401, { error: "invalid_token" }));
  mount();

  await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
  expectNoAdminUi();
});

it.each(["admin", "owner"] as const)("shows the admin shell once the server says the role is %s", async (role) => {
  stubAuthApi(() => json(200, { accessToken: "token" }), () => json(200, person(role)));
  mount();

  expect(await screen.findByTestId("admin-page")).toBeTruthy();
  expect(screen.getAllByRole("navigation", { name: "Admin sections" }).length).toBeGreaterThan(0);
  expect(router.replace).not.toHaveBeenCalled();
});
