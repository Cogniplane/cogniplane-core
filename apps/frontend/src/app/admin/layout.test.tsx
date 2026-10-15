// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { useAuth } from "../../lib/auth-context";
import AdminLayout from "./layout";

let pathname = "/admin/overview";
vi.mock("next/navigation", () => ({ usePathname: () => pathname, useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("../../lib/auth-context", () => ({ useAuth: vi.fn() }));
vi.mock("../../hooks/use-organizations", () => ({ useOrganizations: () => [] }));
vi.mock("../../hooks/use-admin-overview-data", () => ({ useAdminOverviewData: () => ({ skillsCount: 2, mcpServersCount: 1 }) }));
vi.mock("../../lib/admin-api", () => ({
  listAdminUsers: vi.fn(async () => []),
  listAdminSkills: vi.fn(async () => []),
  listAdminMcpServers: vi.fn(async () => []),
  listAdminSessions: vi.fn(async () => ({ items: [], nextCursor: null }))
}));

beforeEach(() => {
  vi.mocked(useAuth).mockReturnValue({ user: { tenantId: "tenant-a", userId: "admin-a", role: "admin", email: "admin@example.test" }, isLoading: false, login: vi.fn(), logout: vi.fn() } as unknown as ReturnType<typeof useAuth>);
});
afterEach(cleanup);

function mount(path: string) {
  pathname = path;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><AdminLayout><form><label>Draft name <input defaultValue="" /></label></form></AdminLayout></QueryClientProvider>);
}

const desktopNav = () => screen.getAllByRole("navigation", { name: "Admin sections" })[0];

it.each([
  ["/admin/users/user-1", "People", "People"],
  ["/admin/users-archive", "Overview", "Overview"],
  ["/admin/mcp", "Connections", "Connections"],
  ["/admin/integrations", "Connections", "Connections"],
  ["/admin/pii", "Privacy", "Privacy"],
  ["/admin/organization", "Overview", "Overview"],
  ["/admin/policy", "Policies", "Policies"],
  ["/admin/runtime", "Runtime diagnostics", "Runtime diagnostics"]
])("matches %s to the %s section by whole path segment", (path, title, navLabel) => {
  mount(path);
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(title);
  expect(within(desktopNav()).getByRole("link", { name: new RegExp(`^${navLabel}`) }).getAttribute("aria-current")).toBe("page");
  expect(within(desktopNav()).getAllByRole("link").filter((link) => link.getAttribute("aria-current") === "page")).toHaveLength(1);
});

it("has one Privacy entry and no Organization entry", () => {
  mount("/admin/overview");
  const labels = within(desktopNav()).getAllByRole("link").map((link) => link.textContent);
  expect(labels.filter((label) => label?.startsWith("Privacy"))).toEqual(["Privacy"]);
  expect(labels.some((label) => label?.startsWith("Organization"))).toBe(false);
  expect(screen.queryByText(/gateway routes|provider selection/i)).toBeNull();
});

it("opens quick jump with Ctrl+K from a form field and returns focus to it without resetting the form", async () => {
  mount("/admin/capabilities");
  const field = screen.getByLabelText("Draft name") as HTMLInputElement;
  fireEvent.change(field, { target: { value: "Unsaved text" } });
  field.focus();
  fireEvent.keyDown(field, { key: "k", ctrlKey: true });
  const dialog = await screen.findByRole("dialog", { name: "Jump to" });
  expect(document.activeElement).toBe(within(dialog).getByRole("combobox"));
  fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(field);
  expect(field.value).toBe("Unsaved text");
});

it("offers a visible quick jump button in the admin header", async () => {
  mount("/admin/overview");
  fireEvent.click(screen.getByRole("button", { name: "Jump to…" }));
  expect(await screen.findByRole("dialog", { name: "Jump to" })).toBeTruthy();
});
