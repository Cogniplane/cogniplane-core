// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  user: { displayName: "Ada Lovelace", email: "ada@example.com", role: "member", tenantSlug: "acme" } as Record<string, unknown>,
  login: vi.fn(),
  logout: vi.fn()
}));
vi.mock("../lib/auth-context", () => ({ useAuth: () => auth }));
vi.mock("../hooks/use-organizations", () => ({
  useOrganizations: () => [{ id: "acme", name: "Acme" }, { id: "globex", name: "Globex" }]
}));
vi.mock("./keyboard-shortcuts-dialog", () => ({ openKeyboardShortcuts: vi.fn() }));
vi.mock("sonner", () => ({ toast: { warning: vi.fn() } }));

import { AccountMenu, accountMenuLinks } from "./account-menu";
import { openKeyboardShortcuts } from "./keyboard-shortcuts-dialog";

beforeEach(() => {
  auth.user = { displayName: "Ada Lovelace", email: "ada@example.com", role: "member", tenantSlug: "acme" };
  document.documentElement.removeAttribute("data-theme");
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

async function openMenu() {
  fireEvent.keyDown(screen.getByRole("button", { name: /Open account menu/ }), { key: "Enter" });
  return screen.findByRole("menu");
}

it("hides the Admin destination from members; AuthGuard still guards the route", () => {
  expect(accountMenuLinks(["chat", "admin"], "member").map((link) => link.label)).toEqual(["Chat"]);
  expect(accountMenuLinks(["chat", "admin"], "admin").map((link) => link.label)).toEqual(["Chat", "Admin"]);
  expect(accountMenuLinks(["chat", "admin"], "owner").map((link) => link.label)).toEqual(["Chat", "Admin"]);
  expect(accountMenuLinks(["admin"], undefined)).toEqual([]);
});

it("shows the person, their destinations, other organizations, shortcuts, and log out", async () => {
  auth.user = { ...auth.user, role: "owner" };
  render(<AccountMenu destinations={["artifacts", "settings", "admin"]} />);
  await openMenu();
  expect(screen.getByText("Ada Lovelace")).toBeTruthy();
  expect(screen.getByText("ada@example.com")).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: /^Admin/ }).getAttribute("href")).toBe("/admin");
  expect(screen.queryByRole("menuitem", { name: /Switch to Acme/ })).toBeNull();

  fireEvent.click(screen.getByRole("menuitem", { name: /Switch to Globex/ }));
  expect(auth.login).toHaveBeenCalledWith({ organization: "globex" });

  await openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: /Keyboard shortcuts/ }));
  await waitFor(() => expect(openKeyboardShortcuts).toHaveBeenCalledOnce());

  await openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: /Log out/ }));
  expect(auth.logout).toHaveBeenCalledOnce();
});

it("offers a theme item only when the header has no theme toggle", async () => {
  const view = render(<AccountMenu destinations={["chat"]} />);
  await openMenu();
  expect(screen.queryByRole("menuitem", { name: /theme/ })).toBeNull();
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  view.unmount();

  render(<AccountMenu destinations={["chat"]} includeTheme />);
  await openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "Switch to dark theme" }));
  expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await openMenu();
  expect(screen.getByRole("menuitem", { name: "Switch to light theme" })).toBeTruthy();
});
