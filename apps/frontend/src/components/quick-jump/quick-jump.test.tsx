// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminMcpServer, AdminSessionRow, AdminSkill, AdminUser, Project, Session } from "@cogniplane/shared-types";

import { listAdminMcpServers, listAdminSessions, listAdminSkills, listAdminUsers } from "../../lib/admin-api";
import { listProjects } from "../../lib/project-api";
import { listSessions } from "../../lib/session-api";
import { QuickJump } from "./quick-jump";
import { connectionItems, quickJumpPages } from "./quick-jump-model";

const push = vi.fn();
let pathname = "/admin/overview";
let role: AdminUser["role"] = "admin";
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }), usePathname: () => pathname }));
vi.mock("../../lib/auth-context", () => ({ useAuth: () => ({ user: { userId: "user/ada", role } }) }));
vi.mock("../../lib/admin-api", () => ({ listAdminUsers: vi.fn(), listAdminSkills: vi.fn(), listAdminMcpServers: vi.fn(), listAdminSessions: vi.fn() }));
vi.mock("../../lib/session-api", () => ({ listSessions: vi.fn() }));
vi.mock("../../lib/project-api", () => ({ listProjects: vi.fn() }));

const ada = { userId: "user/ada", tenantId: "tenant-a", email: "ada@example.test", displayName: "Ada Lovelace", role: "admin", isBetaTester: false, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" } satisfies AdminUser;
const briefing = { skillId: "briefing", skillName: "Briefing writer", description: "Private description hunter2", instructions: "Use the secret phrase hunter2", enabled: true, isPublished: false, activeRevisionId: 3 } as AdminSkill;
const github = { serverId: "github/main", serverName: "GitHub tools", mode: "proxy", upstreamUrl: "https://mcp.example.test/?token=s3cr3t", upstreamAuthType: "none", enabled: true, isAllowed: true, isPublished: true } as AdminMcpServer;
const session = { sessionId: "session/42", userId: "user/ada", userEmail: "ada@example.test", createdAt: "2026-09-26T10:00:00Z", lastActivityAt: "2026-09-26T11:00:00Z", messageCount: 3, runtimeProvider: null, modelName: null, status: "active", alerts: [], skillsUsedCount: 0, mcpServersUsedCount: 0 } satisfies AdminSessionRow;

const launch = { projectId: "project/7", name: "Launch plan", instructions: "Secret project instructions hunter2", instructionsRevision: 1, referenceSessionId: "ref", approvalMode: "ask", agentFileMode: "draft", archivedAt: null, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" } as unknown as Project;
const mySession = { sessionId: "mine/1", projectId: "project/7", userId: "user/ada", sessionName: "Quarterly review", status: "active", createdAt: "2026-09-26T10:00:00Z", updatedAt: "2026-09-26T11:00:00Z" } satisfies Session;

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><QuickJump /></QueryClientProvider>);
  return { ...view, client };
}

function pressShortcut(target: Element | Window = window) {
  return fireEvent.keyDown(target, { key: "k", ctrlKey: true });
}

async function openAndSearch(text: string) {
  pressShortcut();
  const dialog = await screen.findByRole("dialog", { name: "Jump to" });
  fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: text } });
  return dialog;
}

const optionNames = (dialog: HTMLElement) => within(dialog).queryAllByRole("option").map((option) => option.textContent);

beforeEach(() => {
  pathname = "/admin/overview";
  role = "admin";
  vi.mocked(listSessions).mockResolvedValue({ sessions: [mySession], trashRetentionDays: 30 });
  vi.mocked(listProjects).mockResolvedValue([launch]);
  vi.mocked(listAdminUsers).mockResolvedValue([ada]);
  vi.mocked(listAdminSkills).mockResolvedValue([briefing]);
  vi.mocked(listAdminMcpServers).mockResolvedValue([github]);
  vi.mocked(listAdminSessions).mockResolvedValue({ items: [session], nextCursor: "next" });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); document.body.innerHTML = ""; });

it("reads admin lists only after it opens, and reads one page of recent sessions", async () => {
  mount();
  expect(listAdminUsers).not.toHaveBeenCalled();
  expect(listAdminSessions).not.toHaveBeenCalled();
  expect(listAdminSkills).not.toHaveBeenCalled();
  expect(listAdminMcpServers).not.toHaveBeenCalled();

  const dialog = await openAndSearch("");
  expect(within(dialog).getByRole("group", { name: "Pages" })).toBeTruthy();
  await waitFor(() => expect(listAdminSessions).toHaveBeenCalledOnce());
  expect(listAdminSessions).toHaveBeenCalledWith({ limit: 50 });
  expect(listAdminUsers).toHaveBeenCalledOnce();
});

it("moves with the arrow keys, opens the result with Enter, and returns focus to the button", async () => {
  mount();
  const dialog = await openAndSearch("ada");
  const sessionOption = await within(dialog).findByRole("option", { name: /^Session by Ada Lovelace/ });
  const input = within(dialog).getByRole("combobox");
  const options = within(dialog).getAllByRole("option");
  expect(options).toEqual([within(dialog).getByRole("option", { name: /^Ada Lovelace/ }), sessionOption]);
  expect(input.getAttribute("aria-activedescendant")).toBe(options[0].id);

  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(input.getAttribute("aria-activedescendant")).toBe(options[1].id);
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(input.getAttribute("aria-activedescendant")).toBe(options[0].id);
  fireEvent.keyDown(input, { key: "ArrowUp" });
  expect(options[1].getAttribute("aria-selected")).toBe("true");

  fireEvent.keyDown(input, { key: "Enter" });
  expect(push).toHaveBeenCalledWith("/admin/sessions/session%2F42");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Jump to…" }));
});

it("links people, skills, and connections to their pages with encoded IDs", async () => {
  mount();
  const dialog = await openAndSearch("ada");
  fireEvent.click(await within(dialog).findByRole("option", { name: /^Ada Lovelace/ }));
  expect(push).toHaveBeenLastCalledWith("/admin/users/user%2Fada");

  const again = await openAndSearch("github");
  fireEvent.click(await within(again).findByRole("option", { name: /^GitHub tools/ }));
  expect(push).toHaveBeenLastCalledWith("/admin/connections?connection=github%2Fmain");

  const skill = await openAndSearch("briefing");
  fireEvent.click(await within(skill).findByRole("option", { name: /^Briefing writer/ }));
  expect(push).toHaveBeenLastCalledWith("/admin/skills?skill=briefing");
});

it("says that only recent sessions are searched and links to the full Sessions page", async () => {
  mount();
  const dialog = await openAndSearch("ada");
  expect(await within(dialog).findByText(/only the 50 most recently active are searched here/)).toBeTruthy();
  expect(within(dialog).getByRole("group", { name: "Organization sessions" })).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Filter all sessions" }));
  expect(push).toHaveBeenCalledWith("/admin/sessions");
});

it("keeps working categories when one fails, and does not claim no matches for the failed one", async () => {
  vi.mocked(listAdminUsers).mockRejectedValueOnce(new Error("Internal database detail"));
  mount();
  const dialog = await openAndSearch("briefing");
  expect(await within(dialog).findByRole("option", { name: /^Briefing writer/ })).toBeTruthy();
  expect(within(dialog).getByText("Could not load people. They were not searched.")).toBeTruthy();
  expect(within(dialog).queryByText(/Internal database detail/)).toBeNull();

  fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "nothing-matches" } });
  expect(within(dialog).getByText("No matches in pages, your sessions, projects, skills, connections and organization sessions.")).toBeTruthy();

  vi.mocked(listAdminUsers).mockResolvedValue([ada]);
  fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "lovelace" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Retry people" }));
  expect(await within(dialog).findByRole("option", { name: /^Ada Lovelace/ })).toBeTruthy();
  expect(within(dialog).queryByText(/Could not load people/)).toBeNull();
});

it("shows a loading line for a category that has not answered yet", async () => {
  vi.mocked(listAdminSessions).mockReturnValue(new Promise(() => {}));
  mount();
  const dialog = await openAndSearch("ada");
  expect(await within(dialog).findByText("Loading organization sessions…")).toBeTruthy();
  expect(await within(dialog).findByRole("option", { name: /^Ada Lovelace/ })).toBeTruthy();
});

it("renders names as text and never searches instructions, descriptions, or connection URLs", async () => {
  vi.mocked(listAdminUsers).mockResolvedValue([{ ...ada, displayName: "<img src=x onerror=alert(1)>" }]);
  mount();
  const dialog = await openAndSearch("img");
  expect(await within(dialog).findByRole("option", { name: /^<img src=x onerror=alert\(1\)>/ })).toBeTruthy();
  expect(dialog.querySelector("img")).toBeNull();

  for (const secret of ["hunter2", "s3cr3t"]) {
    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: secret } });
    await waitFor(() => expect(within(dialog).getByText(/^No matches in/)).toBeTruthy());
    expect(optionNames(dialog)).toEqual([]);
  }
  expect(dialog.textContent).not.toContain("hunter2");
  expect(dialog.textContent).not.toContain("mcp.example.test");
});

it("does not open over another dialog or from a rich text editor", async () => {
  mount();
  const other = document.createElement("div");
  other.setAttribute("role", "dialog");
  other.setAttribute("data-state", "open");
  document.body.appendChild(other);
  expect(pressShortcut()).toBe(true);
  other.remove();

  const editor = document.createElement("div");
  editor.contentEditable = "true";
  Object.defineProperty(editor, "isContentEditable", { value: true });
  document.body.appendChild(editor);
  expect(pressShortcut(editor)).toBe(true);
  expect(screen.queryByRole("dialog")).toBeNull();

  expect(pressShortcut()).toBe(false);
  expect(await screen.findByRole("dialog", { name: "Jump to" })).toBeTruthy();
});

it("stops listening for the shortcut when the header unmounts", () => {
  const view = mount();
  view.unmount();
  expect(pressShortcut()).toBe(true);
});

it("gives members their pages, sessions, and projects, and never reads admin lists", async () => {
  role = "member";
  pathname = "/";
  mount();
  const dialog = await openAndSearch("");
  const pages = optionNames(within(dialog).getByRole("group", { name: "Pages" }));
  expect(pages[0]).toMatch(/^Chat/);
  expect(pages.some((name) => name?.startsWith("Connected accounts"))).toBe(true);
  expect(pages.some((name) => name?.startsWith("Models"))).toBe(false);

  fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "launch" } });
  const project = await within(dialog).findByRole("option", { name: /^Launch plan/ });
  expect(within(dialog).getByRole("option", { name: /^Quarterly review.*Launch plan/ })).toBeTruthy();
  fireEvent.click(project);
  expect(push).toHaveBeenLastCalledWith("/projects?project=project%2F7");

  const again = await openAndSearch("quarterly");
  fireEvent.click(await within(again).findByRole("option", { name: /^Quarterly review/ }));
  expect(push).toHaveBeenLastCalledWith("/?session=mine%2F1");
  expect(listAdminUsers).not.toHaveBeenCalled();
  expect(listAdminSessions).not.toHaveBeenCalled();
  expect(within(again).queryByRole("button", { name: "Filter all sessions" })).toBeNull();
});

it("never searches project instructions", async () => {
  role = "member";
  mount();
  const dialog = await openAndSearch("hunter2");
  await waitFor(() => expect(within(dialog).getByText("No matches in pages, your sessions and projects.")).toBeTruthy());
});

describe("quickJumpPages", () => {
  const areas = (pathname: string) => quickJumpPages({ isAdmin: true, pathname }).map((item) => item.href);
  it("lists the pages of the current area first", () => {
    expect(areas("/admin/models")[0]).toBe("/admin/overview");
    expect(areas("/settings/token-usage")[0]).toBe("/settings/connections");
    expect(areas("/projects")[0]).toBe("/");
  });
});

describe("connectionItems", () => {
  const detail = (server: Partial<AdminMcpServer>) => connectionItems([{ ...github, ...server }])[0].detail;
  it("uses the same availability as the Connections page", () => {
    expect(detail({})).toBe("MCP connection · Available to members");
    expect(detail({ isPublished: false })).toBe("MCP connection · Available to test users");
  });
  it("shows Off for a connection that the allowlist excludes", () => {
    expect(detail({ isAllowed: false })).toBe("MCP connection · Off");
  });
  it("shows Setup incomplete when the upstream URL or secret is missing", () => {
    expect(detail({ upstreamUrl: null })).toBe("MCP connection · Setup incomplete");
    expect(detail({ upstreamAuthType: "bearer", upstreamAuthConfigured: false })).toBe("MCP connection · Setup incomplete");
  });
});
