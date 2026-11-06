// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminUser } from "@cogniplane/shared-types";

import { listAdminUsers } from "../../../lib/admin-api";
import Page from "./page";

const nav = vi.hoisted(() => ({ query: "", replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(nav.query),
  useRouter: () => ({ replace: nav.replace, push: vi.fn() })
}));
vi.mock("../../../lib/admin-api", () => ({ listAdminUsers: vi.fn() }));
const auth = vi.hoisted(() => ({
  user: { userId: "walter", tenantId: "tenant-a", role: "owner", loginType: "workos" } as Record<string, unknown> | null
}));
vi.mock("../../../lib/auth-context", () => ({ useAuth: () => ({ user: auth.user }) }));

function person(userId: string, overrides: Partial<AdminUser> = {}): AdminUser {
  return {
    userId, tenantId: "tenant-a", email: `${userId}@example.test`, displayName: null, role: "member",
    isBetaTester: false, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

const clients: QueryClient[] = [];
function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  return render(<QueryClientProvider client={client}><Page /></QueryClientProvider>);
}

beforeEach(() => {
  vi.resetAllMocks();
  nav.query = "";
  auth.user = { userId: "walter", tenantId: "tenant-a", role: "owner", loginType: "workos" };
  vi.mocked(listAdminUsers).mockResolvedValue([
    person("dana", { displayName: "Dana Scully", isBetaTester: true }),
    person("fox", { displayName: "Fox Mulder", role: "admin" }),
    person("walter", { role: "owner" })
  ]);
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
});

describe("people directory", () => {
  it("links each person to their page and filters by name, email, or ID", async () => {
    renderPage();
    const list = await screen.findByRole("list", { name: "People" });
    expect(within(list).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
      "/admin/users/dana", "/admin/users/fox", "/admin/users/walter"
    ]);
    expect(screen.getByText(/3 members, 1 with test access/)).toBeTruthy();

    const search = screen.getByLabelText("Search people");
    fireEvent.change(search, { target: { value: "MULDER" } });
    expect(within(list).getAllByRole("link").map((link) => link.textContent)).toEqual([expect.stringContaining("Fox Mulder")]);
    fireEvent.change(search, { target: { value: "walter@" } });
    expect(within(screen.getByRole("list", { name: "People" })).getByRole("link").getAttribute("href")).toBe("/admin/users/walter");
    fireEvent.change(search, { target: { value: "nobody" } });
    expect(screen.getByText('No one matches "nobody".')).toBeTruthy();
  });

  it("offers a retry when the list fails to load", async () => {
    vi.mocked(listAdminUsers).mockRejectedValueOnce(new Error("Network down"));
    renderPage();
    const alert = await screen.findByRole("alert");
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("list", { name: "People" })).toBeTruthy();
  });

  it("sends an old ?userId= link to the person page", () => {
    nav.query = "userId=dana";
    renderPage();
    expect(nav.replace).toHaveBeenCalledWith("/admin/users/dana");
    expect(screen.getByRole("status").textContent).toBe("Opening person…");
  });

  // Local tenants: managers add people; a WorkOS tenant gets people from sign-in.
  it("offers Add person only to a manager of a local tenant", async () => {
    renderPage();
    await screen.findByRole("list", { name: "People" });
    expect(screen.queryByRole("button", { name: "Add person" })).toBeNull();
    cleanup();

    auth.user = { userId: "walter", tenantId: "tenant-a", role: "owner", loginType: "local" };
    renderPage();
    await screen.findByRole("list", { name: "People" });
    expect(screen.getByRole("button", { name: "Add person" })).toBeTruthy();
  });

  it("marks local accounts that are not set up or disabled", async () => {
    vi.mocked(listAdminUsers).mockResolvedValue([
      person("ann", { accountStatus: "pending_setup" }),
      person("bob", { accountStatus: "disabled" }),
      person("cat", { accountStatus: "active" }),
      person("dan", { accountStatus: null })
    ]);
    renderPage();
    const list = await screen.findByRole("list", { name: "People" });
    const row = (id: string) => within(list).getByText(`${id}@example.test`).closest("a")!;
    expect(within(row("ann")).getByText("Not set up")).toBeTruthy();
    expect(within(row("bob")).getByText("Disabled")).toBeTruthy();
    expect(within(row("cat")).queryByText("Active")).toBeNull();
    expect(within(row("dan")).queryByText("Not set up")).toBeNull();
  });
});
