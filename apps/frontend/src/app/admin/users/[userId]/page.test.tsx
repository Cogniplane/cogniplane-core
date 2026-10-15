// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminPersonAccessResponse, AdminSessionRow, AdminUser, PersonAccessItem } from "@cogniplane/shared-types";

import { ApiError } from "../../../../lib/api-client";
import {
  changeMemberRole,
  getAdminPersonAccess,
  listAdminSessions,
  listAdminUsers,
  removeMember,
  setUserBetaTester
} from "../../../../lib/admin-api";
import { fetchMemberMonthUsage, type MemberMonthUsage } from "../../../../lib/token-usage-api";
import Page from "./page";

const nav = vi.hoisted(() => ({ userId: "dana", search: "", push: vi.fn(), replace: vi.fn() }));
const auth = vi.hoisted(() => ({ user: { userId: "owner-1", tenantId: "tenant-a", role: "owner" as "owner" | "admin" } }));
const toast = vi.hoisted(() => ({ success: vi.fn() }));

vi.mock("next/navigation", () => ({
  useParams: () => ({ userId: nav.userId }),
  usePathname: () => `/admin/users/${nav.userId}`,
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: nav.push, replace: nav.replace })
}));
vi.mock("../../../../lib/auth-context", () => ({ useAuth: () => auth }));
vi.mock("sonner", () => ({ toast }));
vi.mock("../../../../lib/admin-api", () => ({
  listAdminUsers: vi.fn(),
  listAdminSessions: vi.fn(),
  getAdminPersonAccess: vi.fn(),
  setUserBetaTester: vi.fn(),
  changeMemberRole: vi.fn(),
  removeMember: vi.fn()
}));
vi.mock("../../../../lib/token-usage-api", () => ({ fetchMemberMonthUsage: vi.fn() }));

function member(overrides: Partial<AdminUser> = {}): AdminUser {
  return {
    userId: "dana", tenantId: "tenant-a", email: "dana@example.test", displayName: "Dana Scully",
    role: "member", isBetaTester: false, createdAt: "2026-01-10T12:00:00.000Z", updatedAt: "2026-01-10T12:00:00.000Z",
    ...overrides
  };
}

const people = () => [
  member(),
  member({ userId: "owner-1", displayName: "Olivia Owner", email: "o@example.test", role: "owner" }),
  member({ userId: "admin-2", displayName: "Adam Admin", email: "a@example.test", role: "admin" })
];

const usage: MemberMonthUsage = {
  range: { from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" },
  usage: {
    daily: [],
    byUser: [],
    byModel: [
      { modelName: "claude-sonnet-5", inputTokens: 1000, outputTokens: 500, totalTokens: 1500, costUsd: 0.02 },
      { modelName: "gpt-6-astra", inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0.001 }
    ],
    totals: { inputTokens: 1100, outputTokens: 550, totalTokens: 1650, costUsd: 0.021, messageCount: 4 }
  }
};

function session(overrides: Partial<AdminSessionRow> = {}): AdminSessionRow {
  return {
    sessionId: "sess-1", userId: "dana", userEmail: "dana@example.test",
    createdAt: "2026-09-20T10:00:00.000Z", lastActivityAt: "2026-09-20T11:00:00.000Z",
    messageCount: 7, runtimeProvider: null, modelName: "claude-sonnet-5", status: "active",
    alerts: [], skillsUsedCount: 1, mcpServersUsedCount: 0,
    ...overrides
  } as AdminSessionRow;
}

const clients: QueryClient[] = [];
function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  return render(<QueryClientProvider client={client}><Page /></QueryClientProvider>);
}

beforeEach(() => {
  vi.resetAllMocks();
  nav.userId = "dana";
  nav.search = "";
  auth.user = { userId: "owner-1", tenantId: "tenant-a", role: "owner" };
  vi.mocked(listAdminUsers).mockResolvedValue(people());
  vi.mocked(fetchMemberMonthUsage).mockResolvedValue(usage);
  vi.mocked(listAdminSessions).mockResolvedValue({
    items: [session(), session({ sessionId: "sess-other", userId: "someone-else" })],
    nextCursor: null
  });
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
});

const access = () => screen.getByRole("complementary", { name: "Access" });

describe("person page", () => {
  it("shows identity, this month's usage, and linked recent sessions for the person", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { level: 2, name: "Dana Scully" })).toBeTruthy();
    expect(screen.getByText("dana@example.test")).toBeTruthy();
    expect(await screen.findByText("1.6k")).toBeTruthy();
    expect(screen.getByText(/September 2026, UTC/)).toBeTruthy();
    expect(screen.getByText("claude-sonnet-5", { selector: "span" })).toBeTruthy();
    expect(fetchMemberMonthUsage).toHaveBeenCalledWith("dana");
    expect(listAdminSessions).toHaveBeenCalledWith({ userId: "dana", limit: 6 });

    const link = await screen.findByRole("link", { name: /7 messages/ });
    expect(link.getAttribute("href")).toBe("/admin/sessions/sess-1?from=userId%3Ddana");
    // A row for another user is never shown, even if the API returned one.
    expect(screen.queryByText("sess-other")).toBeNull();
    expect(screen.getByRole("link", { name: "All sessions by Dana" }).getAttribute("href")).toBe("/admin/sessions?userId=dana");
  });

  it("shows one Errored badge and names connections in session rows", async () => {
    vi.mocked(listAdminSessions).mockResolvedValue({
      items: [session({ status: "errored", alerts: [{ kind: "errored", count: 1 }], mcpServersUsedCount: 1 })],
      nextCursor: null
    });
    renderPage();
    const link = await screen.findByRole("link", { name: /7 messages/ });
    expect(within(link).getAllByText("Errored")).toHaveLength(1);
    expect(within(link).getByText("1 connection")).toBeTruthy();
    expect(within(link).queryByText(/MCP/)).toBeNull();
  });

  it("decodes the route parameter once, so a literal percent sequence in an ID stays intact", async () => {
    // useParams returns the encoded segment: the ID "a%25b" arrives as "a%2525b".
    nav.userId = "a%2525b";
    vi.mocked(listAdminUsers).mockResolvedValue([member({ userId: "a%25b", displayName: "Percent Person" })]);
    renderPage();
    expect(await screen.findByRole("heading", { level: 2, name: "Percent Person" })).toBeTruthy();
    expect(fetchMemberMonthUsage).toHaveBeenCalledWith("a%25b");
  });

  it("shows a loading state until the people list arrives", async () => {
    let resolve!: (users: AdminUser[]) => void;
    vi.mocked(listAdminUsers).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    renderPage();
    expect(screen.getByRole("status", { name: "Loading person" })).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "Access" })).toBeNull();
    resolve(people());
    expect(await screen.findByRole("heading", { level: 2, name: "Dana Scully" })).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Loading person" })).toBeNull();
  });

  it("drops the open dialog and data of the previous person on navigation", async () => {
    const view = renderPage();
    await screen.findByRole("heading", { level: 2, name: "Dana Scully" });
    await screen.findByText("1.6k");
    fireEvent.click(within(access()).getByRole("button", { name: "Change role" }));
    expect(await screen.findByRole("alertdialog")).toBeTruthy();

    let resolveUsage!: (value: MemberMonthUsage) => void;
    vi.mocked(fetchMemberMonthUsage).mockImplementationOnce(() => new Promise((done) => { resolveUsage = done; }));
    nav.userId = "admin-2";
    view.rerender(<QueryClientProvider client={clients[0]!}><Page /></QueryClientProvider>);

    expect(await screen.findByRole("heading", { level: 2, name: "Adam Admin" })).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    // Dana's usage is not shown while Adam's usage loads.
    expect(screen.queryByText("1.6k")).toBeNull();
    expect(screen.getByRole("status", { name: "Loading usage" })).toBeTruthy();
    expect(fetchMemberMonthUsage).toHaveBeenLastCalledWith("admin-2");
    expect(listAdminSessions).toHaveBeenLastCalledWith({ userId: "admin-2", limit: 6 });
    resolveUsage({ ...usage, usage: { ...usage.usage, totals: { ...usage.usage.totals, totalTokens: 42 } } });
    expect(await screen.findByText("42")).toBeTruthy();
  });

  it("names a person without a name or email by ID and says so", async () => {
    vi.mocked(listAdminUsers).mockResolvedValue([member({ displayName: null, email: null })]);
    renderPage();
    expect(await screen.findByRole("heading", { level: 2, name: "dana" })).toBeTruthy();
    expect(screen.getByText("No name or email on record.")).toBeTruthy();
    expect(await screen.findByRole("link", { name: "All sessions by this person" })).toBeTruthy();
  });

  it("shows a not-found state for an ID outside the organization", async () => {
    nav.userId = "ghost";
    renderPage();
    expect(await screen.findByRole("heading", { name: "No member with this ID" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Find a person" }).getAttribute("href")).toBe("/admin/users");
    expect(screen.queryByRole("complementary", { name: "Access" })).toBeNull();
  });

  it("retries the people list after a failure", async () => {
    vi.mocked(listAdminUsers).mockRejectedValueOnce(new Error("Network down"));
    renderPage();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not load this person. Network down");
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Dana Scully" })).toBeTruthy();
  });

  it("keeps identity and access visible when usage fails, and retries usage alone", async () => {
    vi.mocked(fetchMemberMonthUsage).mockRejectedValueOnce(new Error("Usage offline"));
    renderPage();
    const alert = await screen.findByText(/Could not load usage/);
    expect(alert.textContent).toContain("Usage offline");
    expect(access()).toBeTruthy();
    fireEvent.click(within(alert.parentElement!).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("1.6k")).toBeTruthy();
    expect(fetchMemberMonthUsage).toHaveBeenCalledTimes(2);
  });
});

describe("role change", () => {
  it("saves nothing on cancel and returns focus to Change role", async () => {
    renderPage();
    await screen.findByRole("heading", { level: 2, name: "Dana Scully" });
    const trigger = within(access()).getByRole("button", { name: "Change role" });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("radio", { name: /Admin/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Back" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
    expect(changeMemberRole).not.toHaveBeenCalled();

    // The next opening starts again at the first step with nothing selected.
    fireEvent.click(trigger);
    const reopened = await screen.findByRole("alertdialog");
    expect((within(reopened).getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers only permitted roles and confirms owner elevation as permanent", async () => {
    vi.mocked(changeMemberRole).mockResolvedValue(undefined);
    renderPage();
    await screen.findByRole("heading", { level: 2, name: "Dana Scully" });
    fireEvent.click(within(access()).getByRole("button", { name: "Change role" }));

    const dialog = await screen.findByRole("alertdialog");
    const radios = within(dialog).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((radio) => [radio.value, radio.disabled])).toEqual([["member", true], ["admin", false], ["owner", false]]);
    const next = within(dialog).getByRole("button", { name: "Continue" }) as HTMLButtonElement;
    expect(next.disabled).toBe(true);

    fireEvent.click(radios[2]!);
    fireEvent.click(next);
    expect(within(dialog).getByRole("heading", { name: "Make Dana Scully an owner?" })).toBeTruthy();
    expect(dialog.textContent).toMatch(/You cannot undo this\. No one, including other owners, can demote or remove an owner\./);
    expect(changeMemberRole).not.toHaveBeenCalled();

    vi.mocked(listAdminUsers).mockResolvedValue(people().map((user) => user.userId === "dana" ? { ...user, role: "owner" as const } : user));
    fireEvent.click(within(dialog).getByRole("button", { name: "Make owner" }));
    await waitFor(() => expect(changeMemberRole).toHaveBeenCalledWith("dana", "owner"));
    expect(await within(access()).findByText("Role changed to owner.")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(within(access()).queryByRole("button", { name: "Change role" })).toBeNull();
    // The trigger is gone for an owner, so focus goes to the Access heading.
    expect(document.activeElement).toBe(within(access()).getByRole("heading", { name: "Access" }));
  });

  it("shows the backend reason and keeps the dialog open when the change fails", async () => {
    vi.mocked(changeMemberRole).mockRejectedValue(new ApiError({
      status: 403, code: "only_owner_can_assign_admin", method: "PUT", path: "/tenant/members/dana/role", message: "only_owner_can_assign_admin"
    }));
    renderPage();
    await screen.findByRole("heading", { level: 2, name: "Dana Scully" });
    fireEvent.click(within(access()).getByRole("button", { name: "Change role" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("radio", { name: /Admin/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Change to admin" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("Only owners can make someone an admin.");
  });

  it("hides role changes from admins and explains why", async () => {
    auth.user = { userId: "admin-2", tenantId: "tenant-a", role: "admin" };
    renderPage();
    await screen.findByRole("heading", { level: 2, name: "Dana Scully" });
    expect(within(access()).queryByRole("button", { name: "Change role" })).toBeNull();
    expect(within(access()).getByText("Only owners can change roles.")).toBeTruthy();
    // Admins can still remove members, as the backend permits.
    expect(within(access()).getByRole("button", { name: /Remove from organization/ })).toBeTruthy();
  });

  it("hides role change and removal for an owner and for yourself", async () => {
    nav.userId = "owner-1";
    renderPage();
    await screen.findByRole("heading", { level: 2, name: "Olivia Owner" });
    expect(within(access()).queryByRole("button", { name: "Change role" })).toBeNull();
    expect(within(access()).queryByRole("button", { name: /Remove from organization/ })).toBeNull();
    expect(within(access()).getByText("You cannot change your own role.")).toBeTruthy();
    expect(within(access()).getByText("You cannot remove yourself.")).toBeTruthy();
  });
});

describe("test access", () => {
  it("turns test access on directly and describes its scope", async () => {
    vi.mocked(setUserBetaTester).mockResolvedValue(member({ isBetaTester: true }));
    renderPage();
    await screen.findByRole("heading", { level: 2, name: "Dana Scully" });
    expect(within(access()).getByText(/skill releases and connections that an admin released to test users\. Unreleased drafts stay hidden\./)).toBeTruthy();
    vi.mocked(listAdminUsers).mockResolvedValue(people().map((user) => user.userId === "dana" ? { ...user, isBetaTester: true } : user));
    fireEvent.click(within(access()).getByRole("button", { name: "Turn on test access" }));
    await waitFor(() => expect(setUserBetaTester).toHaveBeenCalledWith("dana", true));
    expect(await within(access()).findByText("Test access is on.")).toBeTruthy();
    expect(within(access()).getByRole("button", { name: "Turn off test access" })).toBeTruthy();
  });

  it("shows a failure next to the action", async () => {
    vi.mocked(setUserBetaTester).mockRejectedValue(new Error("Server busy"));
    renderPage();
    await screen.findByRole("heading", { level: 2, name: "Dana Scully" });
    fireEvent.click(within(access()).getByRole("button", { name: "Turn on test access" }));
    expect((await within(access()).findByRole("alert")).textContent).toBe("Server busy");
  });
});

describe("removal", () => {
  async function openRemoval() {
    renderPage();
    await screen.findByRole("heading", { level: 2, name: "Dana Scully" });
    fireEvent.click(within(access()).getByRole("button", { name: /Remove from organization/ }));
    return screen.findByRole("alertdialog");
  }

  it("states the effects, blocks closing while pending, and keeps a failure retryable", async () => {
    let fail!: (error: Error) => void;
    vi.mocked(removeMember).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const dialog = await openRemoval();
    expect(dialog.textContent).toMatch(/lose access to this organization on their next request/);
    expect(dialog.textContent).toMatch(/scheduled jobs are turned off/);
    expect(dialog.textContent).toMatch(/cannot guarantee revocation at the external service/);
    expect(dialog.textContent).toMatch(/past sessions are not deleted\. You cannot undo this\./);
    expect(removeMember).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Remove from organization" }));
    const pending = await within(dialog).findByRole("button", { name: "Removing…" }) as HTMLButtonElement;
    expect(pending.disabled).toBe(true);
    expect((within(dialog).getByRole("button", { name: "Keep Dana Scully" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByRole("alertdialog")).toBeTruthy();

    fail(new Error("Database unavailable"));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("Database unavailable");
    vi.mocked(removeMember).mockResolvedValueOnce(undefined);
    fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/admin/users"));
    expect(toast.success).toHaveBeenCalledWith("Dana Scully was removed from the organization.");
    expect(removeMember).toHaveBeenCalledTimes(2);
  });

  it("keeps the member on cancel and returns focus to the remove action", async () => {
    const dialog = await openRemoval();
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep Dana Scully" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(document.activeElement).toBe(within(access()).getByRole("button", { name: /Remove from organization/ }));
    expect(removeMember).not.toHaveBeenCalled();
  });

  it("treats an already removed member as done", async () => {
    vi.mocked(removeMember).mockRejectedValue(new ApiError({
      status: 404, code: "member_not_found", method: "DELETE", path: "/tenant/members/dana", message: "member_not_found"
    }));
    const dialog = await openRemoval();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove from organization" }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/admin/users"));
    expect(toast.success).toHaveBeenCalledWith("Dana Scully is no longer a member of the organization.");
  });
});

function accessItem(overrides: Partial<PersonAccessItem> & Pick<PersonAccessItem, "id" | "name">): PersonAccessItem {
  return {
    kind: "skill", runtimeSource: "organization", adminPageSource: "organization", signIn: null, status: "included",
    gates: [
      { gate: "visible_to_member", result: "pass" },
      { gate: "allowed_for_organization", result: "pass" },
      { gate: "in_member_defaults", result: "pass" },
      { gate: "has_instructions", result: "pass" }
    ],
    ...overrides
  };
}

const contractReview = accessItem({
  id: "contract-review", name: "Contract review", status: "excluded", runtimeSource: null,
  gates: [
    { gate: "visible_to_member", result: "fail", reason: "test_users_only" },
    { gate: "allowed_for_organization", result: "not_checked" },
    { gate: "in_member_defaults", result: "not_checked" },
    { gate: "has_instructions", result: "not_checked" }
  ]
});
const jira = accessItem({
  kind: "connection", id: "jira", name: "Jira", status: "excluded", signIn: "personal",
  gates: [
    { gate: "visible_to_member", result: "pass" },
    { gate: "allowed_for_organization", result: "pass" },
    { gate: "in_member_defaults", result: "pass" },
    { gate: "personal_sign_in", result: "fail", reason: "member_must_reconnect" }
  ]
});
const salesforce = accessItem({
  kind: "connection", id: "salesforce", name: "Salesforce", status: "excluded", signIn: "organization",
  gates: [
    { gate: "visible_to_member", result: "pass" },
    { gate: "allowed_for_organization", result: "pass" },
    { gate: "in_member_defaults", result: "fail", reason: "not_in_member_defaults" }
  ]
});
const search = accessItem({
  kind: "connection", id: "search", name: "Search", status: "unknown", signIn: "personal",
  runtimeSource: "system", adminPageSource: "system",
  gates: [
    { gate: "visible_to_member", result: "pass" },
    { gate: "allowed_for_organization", result: "pass" },
    { gate: "in_member_defaults", result: "pass" },
    { gate: "personal_sign_in", result: "unknown", reason: "legacy_settings_pending" }
  ]
});
const webResearch = accessItem({ id: "web-research", name: "Web research" });

function accessResult(overrides: Partial<AdminPersonAccessResponse> = {}): AdminPersonAccessResponse {
  return {
    tenantId: "tenant-a", userId: "dana", scope: "new_standalone_chat", checkedAt: new Date().toISOString(),
    member: { isTestUser: false, defaults: "custom" },
    notCovered: ["projects", "tool_permissions", "live_connection_health"],
    items: [webResearch, search, salesforce, jira, contractReview],
    ...overrides
  };
}

async function openSkillsTab() {
  nav.search = "tab=skills-connections";
  const view = renderPage();
  await screen.findByRole("heading", { level: 2, name: "Dana Scully" });
  const list = await screen.findByRole("list", { name: "Skills and connections" });
  return { view, list };
}

// Collapsed check lists stay in the DOM with `hidden`; read only what is shown.
const shown = { ignore: "[hidden], [hidden] *, script, style" };

const rowNames = (list: HTMLElement) =>
  within(list).getAllByRole("listitem").filter((row) => row.parentElement === list)
    .map((row) => row.querySelector("p")?.textContent);

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, "clipboard", { value, configurable: true });
}

describe("skills and connections", () => {
  beforeEach(() => {
    vi.mocked(getAdminPersonAccess).mockResolvedValue(accessResult());
  });

  it("loads only after the tab is selected and follows the URL on back and forward", async () => {
    const view = renderPage();
    await screen.findByRole("heading", { level: 2, name: "Dana Scully" });
    expect(screen.getByRole("tab", { name: "Activity" }).getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByRole("link", { name: "All sessions by Dana" })).toBeTruthy();
    expect(getAdminPersonAccess).not.toHaveBeenCalled();

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Skills & connections" }), { button: 0, ctrlKey: false });
    expect(nav.push).toHaveBeenCalledWith("/admin/users/dana?tab=skills-connections", { scroll: false });
    expect(getAdminPersonAccess).not.toHaveBeenCalled();

    // The router changes the URL; the page follows it.
    nav.search = "tab=skills-connections";
    view.rerender(<QueryClientProvider client={clients.at(-1)!}><Page /></QueryClientProvider>);
    expect(screen.getByRole("tab", { name: "Skills & connections" }).getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByRole("list", { name: "Skills and connections" })).toBeTruthy();
    expect(getAdminPersonAccess).toHaveBeenCalledWith("dana", { tenantId: "tenant-a" });
    expect(screen.getByRole("complementary", { name: "Access" })).toBeTruthy();

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Activity" }), { button: 0, ctrlKey: false });
    expect(nav.push).toHaveBeenLastCalledWith("/admin/users/dana", { scroll: false });

    // Back button: the URL loses the tab parameter.
    nav.search = "";
    view.rerender(<QueryClientProvider client={clients.at(-1)!}><Page /></QueryClientProvider>);
    expect(screen.getByRole("tab", { name: "Activity" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("link", { name: "All sessions by Dana" })).toBeTruthy();
    expect(getAdminPersonAccess).toHaveBeenCalledTimes(1);
  });

  it("starts with excluded and unknown items and filters by status and search", async () => {
    const { list } = await openSkillsTab();
    expect(rowNames(list)).toEqual(["Contract review", "Jira", "Salesforce", "Search"]);
    expect(screen.getByText("3 excluded, 1 unknown, 1 included")).toBeTruthy();
    expect(within(list).getByText("Released to test users only.", shown)).toBeTruthy();
    expect(within(list).getByText("Dana must sign in again.", shown)).toBeTruthy();
    expect(within(list).getByText(/Saved connection settings need review/, shown)).toBeTruthy();
    // Granting test access changes every test resource; it is never offered as a fix for one item.
    expect(list.textContent).not.toMatch(/test access/i);

    const show = screen.getByRole("group", { name: "Show" });
    expect(within(show).getByRole("button", { name: /^Excluded or unknown/ }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(show).getByRole("button", { name: /^Included/ }));
    expect(within(show).getByRole("button", { name: /^Included/ }).getAttribute("aria-pressed")).toBe("true");
    expect(within(show).getByRole("button", { name: /^Excluded or unknown/ }).getAttribute("aria-pressed")).toBe("false");
    expect(rowNames(screen.getByRole("list", { name: "Skills and connections" }))).toEqual(["Web research"]);

    fireEvent.click(within(show).getByRole("button", { name: /^All/ }));
    fireEvent.change(screen.getByLabelText("Search skills and connections"), { target: { value: "JIRA" } });
    expect(rowNames(screen.getByRole("list", { name: "Skills and connections" }))).toEqual(["Jira"]);

    fireEvent.change(screen.getByLabelText("Search skills and connections"), { target: { value: "nothing here" } });
    expect(screen.queryByRole("list", { name: "Skills and connections" })).toBeNull();
    expect(screen.getByText(/No skills or connections match/)).toBeTruthy();
  });

  it("keeps the resource investigation across tab navigation and resets it for another person", async () => {
    const { view } = await openSkillsTab();
    const rerender = () => view.rerender(<QueryClientProvider client={clients.at(-1)!}><Page /></QueryClientProvider>);
    fireEvent.click(screen.getByRole("button", { name: /^All 5/ }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search skills and connections" }), { target: { value: "Salesforce" } });
    fireEvent.click(screen.getByRole("button", { name: "Show checks for Salesforce" }));

    nav.search = "";
    rerender();
    expect(screen.queryByRole("searchbox", { name: "Search skills and connections" })).toBeNull();
    expect(screen.getByRole("link", { name: "All sessions by Dana" })).toBeTruthy();
    nav.search = "tab=skills-connections";
    rerender();
    expect((screen.getByRole("searchbox", { name: "Search skills and connections" }) as HTMLInputElement).value).toBe("Salesforce");
    expect(screen.getByRole("button", { name: /^All 5/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Hide checks for Salesforce" }).getAttribute("aria-expanded")).toBe("true");
    expect(getAdminPersonAccess).toHaveBeenCalledTimes(1);

    nav.userId = "admin-2";
    vi.mocked(getAdminPersonAccess).mockResolvedValue(accessResult({ userId: "admin-2" }));
    rerender();
    const searchbox = await screen.findByRole("searchbox", { name: "Search skills and connections" }) as HTMLInputElement;
    expect(searchbox.value).toBe("");
    expect(screen.getByRole("button", { name: /^Excluded or unknown/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Show checks for Salesforce" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("names the search scope and offers matching resources outside it", async () => {
    await openSkillsTab();
    const input = screen.getByRole("searchbox", { name: "Search skills and connections" });
    fireEvent.change(input, { target: { value: "Web research" } });
    expect(screen.getByText(/No excluded or unknown skills or connections match/)).toBeTruthy();
    const reveal = screen.getByRole("button", { name: "Show 1 match in all resources" });
    expect(screen.queryByRole("list", { name: "Skills and connections" })).toBeNull();
    fireEvent.click(reveal);
    expect(document.activeElement).toBe(input);
    expect(rowNames(screen.getByRole("list", { name: "Skills and connections" }))).toEqual(["Web research"]);
    expect((input as HTMLInputElement).value).toBe("Web research");

    fireEvent.click(screen.getByRole("button", { name: /^Included 1/ }));
    fireEvent.change(input, { target: { value: "Contract" } });
    expect(screen.getByText(/No included skills or connections match/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show 1 match in all resources" })).toBeTruthy();
    fireEvent.change(input, { target: { value: "Does not exist" } });
    expect(screen.queryByRole("button", { name: /matches? in all resources/ })).toBeNull();
  });

  it("explains the first failed check, marks later checks as not checked, and links to the resource", async () => {
    const { list } = await openSkillsTab();
    const row = within(list).getByText("Contract review").closest("li")!;
    expect(within(row).getByRole("link", { name: "Open the skill" }).getAttribute("href")).toBe("/admin/skills?skill=contract-review");
    const toggle = within(row).getByRole("button", { name: "Show checks for Contract review" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const checks = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    const lines = within(checks).getAllByRole("listitem").map((line) => line.textContent);
    expect(lines).toEqual([
      "FailedTurned on and released to DanaReleased to test users only.",
      "Not checkedAllowed for the organization",
      "Not checkedIn Dana's defaults for new chats",
      "Not checkedHas instructions for the agent"
    ]);

    const jiraRow = within(list).getByText("Jira").closest("li")!;
    expect(within(jiraRow).getByRole("link", { name: "Open the connection" }).getAttribute("href")).toBe("/admin/connections?connection=jira");
  });

  it("labels the built-in version a member gets when the admin page shows the organization copy", async () => {
    const fallback = accessItem({ id: "summarize", name: "Summarize", runtimeSource: "system", adminPageSource: "organization" });
    vi.mocked(getAdminPersonAccess).mockResolvedValue(accessResult({ items: [fallback, webResearch] }));
    const { list } = await openSkillsTab();
    const row = within(list).getByText("Summarize").closest("li")!;
    expect(within(row).getByText("Skill · Built in")).toBeTruthy();
    expect(within(row).getByText("Uses the built-in version. The organization copy is not available to Dana.")).toBeTruthy();
    expect(within(row).getByRole("link", { name: "Open the organization copy" }).getAttribute("href")).toBe("/admin/skills?skill=summarize");

    const plain = within(list).getByText("Web research").closest("li")!;
    expect(within(plain).getByText("Skill · Organization")).toBeTruthy();
    expect(within(plain).queryByText(/Uses the/)).toBeNull();
    expect(within(plain).getByRole("link", { name: "Open the skill" })).toBeTruthy();
  });

  it("copies a link to the member's own settings without opening it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    const { list } = await openSkillsTab();

    fireEvent.click(within(list).getByRole("button", { name: "Copy settings link for Dana" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/settings/capabilities?tab=defaults`));
    expect(screen.getByText(/Link copied\. Send it to Dana\. It opens their own settings after they sign in\. Dana can add it under Chat defaults\./)).toBeTruthy();

    fireEvent.click(within(list).getByRole("button", { name: "Copy sign-in link for Dana" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(`${window.location.origin}/settings/connections`));
    expect(nav.push).not.toHaveBeenCalled();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it.each([
    ["rejects", () => setClipboard({ writeText: vi.fn().mockRejectedValue(new Error("denied")) })],
    ["is unavailable", () => setClipboard(undefined)]
  ])("shows the link to copy by hand when the clipboard %s", async (_label, arrange) => {
    arrange();
    const { list } = await openSkillsTab();
    fireEvent.click(within(list).getByRole("button", { name: "Copy sign-in link for Dana" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Could not copy the link\. Copy it here and send it to Dana\./);
    expect((within(alert).getByLabelText("Settings link for Dana") as HTMLInputElement).value)
      .toBe(`${window.location.origin}/settings/connections`);
  });

  it("explains empty defaults once instead of on every row", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    const other = { ...salesforce, id: "hubspot", name: "HubSpot" };
    vi.mocked(getAdminPersonAccess).mockResolvedValue(accessResult({
      member: { isTestUser: true, defaults: "empty" }, items: [salesforce, other]
    }));
    const { list } = await openSkillsTab();
    expect(screen.getAllByText(/Dana chose no defaults for new chats\./)).toHaveLength(1);
    expect(screen.getAllByText(/excluded until Dana adds them/)).toHaveLength(1);
    expect(within(list).getAllByText("Not in defaults. See the note above.")).toHaveLength(2);
    expect(within(list).queryByRole("button", { name: /Copy settings link/ })).toBeNull();
    expect(screen.getByText(/Dana has test access\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy settings link for Dana" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/settings/capabilities?tab=defaults`));
  });

  it("shows a retry state, not an empty list, when the check fails", async () => {
    vi.mocked(getAdminPersonAccess).mockRejectedValueOnce(new Error("Service unavailable"));
    nav.search = "tab=skills-connections";
    renderPage();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Could not check skills and connections\. Service unavailable/);
    expect(screen.queryByRole("list", { name: "Skills and connections" })).toBeNull();
    expect(screen.queryByText(/no skills or MCP connections/)).toBeNull();
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("list", { name: "Skills and connections" })).toBeTruthy();
    expect(getAdminPersonAccess).toHaveBeenCalledTimes(2);
  });

  it("keeps the earlier result visible and labelled when a refresh fails", async () => {
    await openSkillsTab();
    expect(screen.getByText("Checked just now")).toBeTruthy();
    vi.mocked(getAdminPersonAccess).mockRejectedValueOnce(new Error("Timed out"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Could not refresh\. The list below is from the earlier check\. Timed out/);
    expect(screen.getByRole("list", { name: "Skills and connections" })).toBeTruthy();
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(getAdminPersonAccess).toHaveBeenCalledTimes(3);
  });

  it("says when the organization has nothing to check", async () => {
    vi.mocked(getAdminPersonAccess).mockResolvedValue(accessResult({ items: [] }));
    nav.search = "tab=skills-connections";
    renderPage();
    expect(await screen.findByText("The organization has no skills or MCP connections to check.")).toBeTruthy();
    fireEvent.click(screen.getByText("What this covers"));
    expect(screen.getByText("Whether a connected service is working now")).toBeTruthy();
  });

  it("checks again after test access changes", async () => {
    vi.mocked(setUserBetaTester).mockResolvedValue(member({ isBetaTester: true }));
    await openSkillsTab();
    expect(getAdminPersonAccess).toHaveBeenCalledTimes(1);
    fireEvent.click(within(access()).getByRole("button", { name: "Turn on test access" }));
    await waitFor(() => expect(getAdminPersonAccess).toHaveBeenCalledTimes(2));
  });
});
