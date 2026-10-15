// @vitest-environment jsdom
//
// The recovery screen inside the real admin layout, AuthProvider, and
// AuthGuard. Only the network is a stand-in. The role comes from the answer of
// /auth/me. A member must not see the screen, and the screen must not ask the
// backend for the list of projects.

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.hoisted(() => { delete process.env.NEXT_PUBLIC_DEV_USER_ID; });
const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/admin/project-owners", useRouter: () => router }));
vi.mock("../../../hooks/use-organizations", () => ({ useOrganizations: () => [] }));
vi.mock("../../../hooks/use-admin-overview-data", () => ({ useAdminOverviewData: () => ({ skillsCount: 0, mcpServersCount: 0 }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

import { setAccessToken } from "../../../lib/api-client";
import { AuthProvider } from "../../../lib/auth-context";
import AdminLayout from "../layout";
import Page from "./page";

const HINT = "cogniplane_session_hint";
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const person = (role: "owner" | "admin" | "member") => ({
  userId: "u-1", email: "person@example.test", displayName: "Person", tenantId: "t-1", role
});

function stubBackend(role: "owner" | "admin" | "member") {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    if (path === "/auth/refresh") return json(200, { accessToken: "token" });
    if (path === "/auth/me") return json(200, person(role));
    // A member would get this from the real backend.
    if (path === "/admin/projects/ownerless") {
      return role === "member"
        ? json(403, { error: "organization_admin_required", message: "Organization administrator access is required." })
        : json(200, { projects: [{ projectId: "p1", name: "Q3 planning" }] });
    }
    if (path === "/admin/users") return json(200, { users: [] });
    return json(404, { error: "unexpected_call", path });
  }));
  return calls;
}

function mount() {
  return render(<AuthProvider><AdminLayout><Page /></AdminLayout></AuthProvider>);
}

beforeEach(() => {
  setAccessToken(null);
  router.replace.mockClear();
  document.cookie = `${HINT}=1; Path=/`;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.cookie = `${HINT}=; Path=/; Max-Age=0`;
});

it("shows a member no recovery screen, no project name, and never asks for the list", async () => {
  const calls = stubBackend("member");
  mount();

  await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
  expect(screen.queryByRole("heading", { name: "Projects without an owner" })).toBeNull();
  expect(screen.queryByText("Q3 planning")).toBeNull();
  expect(screen.queryByRole("navigation", { name: "Admin sections" })).toBeNull();
  expect(screen.queryByText("Project owners")).toBeNull();
  expect(calls).not.toContain("/admin/projects/ownerless");
});

it.each(["admin", "owner"] as const)("shows the %s the screen and its navigation entry", async (role) => {
  stubBackend(role);
  mount();

  expect(await screen.findByText("Q3 planning")).toBeTruthy();
  expect(screen.getByRole("heading", { level: 2, name: "Projects without an owner" })).toBeTruthy();
  const navigation = screen.getAllByRole("navigation", { name: "Admin sections" })[0]!;
  const entry = within(navigation).getByRole("link", { name: "Project owners" });
  expect(entry.getAttribute("href")).toBe("/admin/project-owners");
  expect(entry.getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Project owners");
});

it("shows a person whose role changed since the page opened only the refusal", async () => {
  // The guard let the page open as admin. The backend now refuses the list.
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path === "/auth/refresh") return json(200, { accessToken: "token" });
    if (path === "/auth/me") return json(200, person("admin"));
    if (path === "/admin/projects/ownerless") return json(403, { error: "organization_admin_required", message: "Organization administrator access is required." });
    return json(404, { error: "unexpected_call", path });
  }));
  mount();

  expect(await screen.findByText("Only organization admins can see and recover projects without an owner.")).toBeTruthy();
  expect(screen.queryByText("Q3 planning")).toBeNull();
  expect(screen.queryByRole("button", { name: /Assign owner/ })).toBeNull();
});
