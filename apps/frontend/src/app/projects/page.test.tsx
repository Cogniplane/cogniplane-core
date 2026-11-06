// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { Project } from "@cogniplane/shared-types";
import * as api from "../../lib/project-api";
import Page from "./page";

const navigation = vi.hoisted(() => ({ listeners: new Set<() => void>(), pushes: [] as string[], replacements: [] as string[] }));
vi.mock("next/navigation", async () => {
  const { useSyncExternalStore } = await import("react");
  const navigate = (href: string) => {
    searchParams = href.split("?")[1] ?? "";
    navigation.listeners.forEach(listener => listener());
  };
  const router = {
    replace: (href: string) => { navigation.replacements.push(href); navigate(href); },
    push: (href: string) => { navigation.pushes.push(href); navigate(href); }
  };
  return {
    useRouter: () => router,
    useSearchParams: () => new URLSearchParams(useSyncExternalStore(listener => {
      navigation.listeners.add(listener);
      return () => { navigation.listeners.delete(listener); };
    }, () => searchParams))
  };
});
vi.mock("../../lib/auth-context", () => ({ useAuth: () => ({ user: { userId: "u" } }) }));
vi.mock("../../lib/auth-guard", () => ({
  AuthGuard: ({ children }: { children: ReactNode }) => children
}));
vi.mock("../../components/console-page-header", () => ({
  ConsolePageHeader: () => <h1>Projects</h1>
}));
vi.mock("../../lib/project-api", () => ({
  listProjects: vi.fn(),
  getProject: vi.fn(),
  getProjectCapabilities: vi.fn(),
  updateProjectCapabilities: vi.fn(),
  getProjectAccess: vi.fn(),
  archiveProject: vi.fn(),
  createProject: vi.fn()
}));
vi.mock("../../lib/session-api", () => ({ listSessions: async () => ({ sessions: [], trashRetentionDays: 30 }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

const time = "2026-09-13T00:00:00Z";
let project: Project;
let client: QueryClient;
let searchParams: string;
beforeEach(() => {
  vi.resetAllMocks();
  navigation.pushes = [];
  navigation.replacements = [];
  searchParams = "project=p1";
  project = {
    projectId: "p1",
    name: "Planning",
    referenceSessionId: "refs",
    approvalMode: "organization_default",
    agentFileMode: "read-only",
    archivedAt: null,
    instructions: "",
    instructionsRevision: 0,
    createdAt: time,
    updatedAt: time
  };
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  vi.mocked(api.listProjects).mockImplementation(async (options) =>
    Boolean(project.archivedAt) === Boolean(options?.archived) ? [{ ...project }] : []
  );
  vi.mocked(api.getProject).mockImplementation(async id => {
    if (id !== project.projectId) throw new Error("Unavailable project");
    return ({
    project: { ...project },
    sessions: [],
    files: [],
    canManage: true
  }); });
  vi.mocked(api.getProjectCapabilities).mockResolvedValue({
    selection: null, version: 1, canEdit: true, skills: [], connectors: []
  });
  vi.mocked(api.getProjectAccess).mockResolvedValue({
    visibility: "private",
    organizationRole: "viewer",
    members: []
  });
  vi.mocked(api.archiveProject).mockImplementation(async (_id, archived) => {
    project.archivedAt = archived ? time : null;
  });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.useRealTimers();
});
const renderPage = () =>
  render(
    <QueryClientProvider client={client}>
      <Page />
    </QueryClientProvider>
  );

it("does not open a different project when the linked project is filtered out", async () => {
  searchParams = "project=missing";
  renderPage();
  await waitFor(() => expect(api.listProjects).toHaveBeenCalled());
  await screen.findByRole("heading", { name: "Could not open this project" });
  expect(api.getProject).toHaveBeenCalledWith("missing");
  expect(screen.queryByRole("heading", { name: "Planning" })).toBeNull();
});

it("keeps the selected project open across archive filters and saves the scope in the URL", async () => {
  searchParams = "project=p1&view=settings";
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "Archive project" }));
  await screen.findByRole("button", { name: "Restore project" });
  expect(screen.getByRole("heading", { name: "Planning" })).toBeTruthy();
  expect(screen.getByText(/This project is outside the current Active list/)).toBeTruthy();
  expect(toast.success).toHaveBeenCalledWith(
    "Project moved to Archived. Restore it to return its sessions to the main screen."
  );
  fireEvent.click(within(screen.getByRole("group", { name: "Project archive filter" })).getByRole("button", { name: "Archived" }));
  await waitFor(() => expect(api.listProjects).toHaveBeenCalledWith({ archived: true, q: "" }));
  expect(navigation.pushes.at(-1)).toBe("/projects?project=p1&view=settings&archived=true");
  expect(screen.getByRole("link", { name: "Overview" }).getAttribute("href")).toBe("/projects?project=p1&archived=true");
  fireEvent.click(screen.getByRole("button", { name: "Restore project" }));
  await screen.findByRole("button", { name: "Archive project" });
  expect(screen.getByText(/This project is outside the current Archived list/)).toBeTruthy();
  fireEvent.click(within(screen.getByRole("group", { name: "Project archive filter" })).getByRole("button", { name: "Active" }));
  await waitFor(() => expect(api.listProjects).toHaveBeenCalledWith({ archived: false, q: "" }));
  expect(api.archiveProject).toHaveBeenNthCalledWith(1, "p1", true);
  expect(api.archiveProject).toHaveBeenNthCalledWith(2, "p1", false);
});

it("keeps the project visible and reports an archive failure", async () => {
  vi.mocked(api.archiveProject).mockRejectedValueOnce(new Error("Archive failed"));
  searchParams = "project=p1&view=settings";
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "Archive project" }));
  await screen.findByText("Archive failed");
  expect(screen.getByRole("heading", { name: "Planning" })).toBeTruthy();
  expect(toast.success).not.toHaveBeenCalled();
});

it("debounces server searches while updating the input immediately", async () => {
  searchParams = "project=p1&view=settings";
  renderPage();
  await screen.findByRole("button", { name: "Archive project" });
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Rename project" }), { target: { value: "Unsaved name" } });
  let finishSearch!: (projects: Project[]) => void;
  vi.mocked(api.listProjects).mockImplementationOnce(() => new Promise((resolve) => { finishSearch = resolve; }));
  vi.useFakeTimers();
  vi.mocked(api.listProjects).mockClear();
  const input = screen.getByLabelText("Search projects and file names");
  fireEvent.change(input, { target: { value: "p" } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
  fireEvent.change(input, { target: { value: "plan" } });
  expect((input as HTMLInputElement).value).toBe("plan");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(299);
  });
  expect(api.listProjects).not.toHaveBeenCalled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  vi.useRealTimers();
  await waitFor(() => expect(api.listProjects).toHaveBeenCalledTimes(1));
  expect(api.listProjects).toHaveBeenCalledWith({ archived: false, q: "plan" });
  expect((screen.getByRole("textbox", { name: "Rename project" }) as HTMLInputElement).value).toBe("Unsaved name");
  await act(async () => { finishSearch([{ ...project }]); });
  expect((screen.getByRole("textbox", { name: "Rename project" }) as HTMLInputElement).value).toBe("Unsaved name");
});

it("selects Overview by default and Settings from the view query", async () => {
  renderPage();
  expect((await screen.findByRole("link", { name: "Overview" })).getAttribute("aria-current"))
    .toBe("page");
  expect(screen.queryByText("Project settings")).toBeNull();
  cleanup();
  client.clear();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });

  searchParams = "project=p1&view=settings";
  renderPage();
  expect((await screen.findByRole("link", { name: "Settings" })).getAttribute("aria-current"))
    .toBe("page");
  expect(await screen.findByText("Project settings")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Sessions" })).toBeNull();
});


it("keeps an open rename draft when search returns other projects or no matches", async () => {
  searchParams = "project=p1&view=settings";
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "Rename" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Rename project" }), { target: { value: "Keep this draft" } });
  vi.mocked(api.listProjects).mockResolvedValue([{ ...project, projectId: "p2", name: "Other work" }]);
  fireEvent.change(screen.getByLabelText("Search projects and file names"), { target: { value: "Other work" } });
  await screen.findByRole("button", { name: "Other work" });
  expect(screen.getByText(/outside the current Active list and search results/)).toBeTruthy();
  expect((screen.getByRole("textbox", { name: "Rename project" }) as HTMLInputElement).value).toBe("Keep this draft");
  vi.mocked(api.listProjects).mockResolvedValue([]);
  fireEvent.change(screen.getByLabelText("Search projects and file names"), { target: { value: "Missing" } });
  await screen.findByText("No matching projects.");
  expect((screen.getByRole("textbox", { name: "Rename project" }) as HTMLInputElement).value).toBe("Keep this draft");
  expect(screen.queryByRole("heading", { name: "No matching projects" })).toBeNull();
});

it("reads archive scope from a restored URL and retains it when choosing a project", async () => {
  searchParams = "project=p1&archived=true";
  project.archivedAt = time;
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "Planning" }));
  expect(navigation.pushes.at(-1)).toBe("/projects?project=p1&archived=true");
  await act(async () => {
    searchParams = "project=p1&archived=false";
    navigation.listeners.forEach(listener => listener());
  });
  await waitFor(() => expect(api.listProjects).toHaveBeenCalledWith({ archived: false, q: "" }));
  expect(within(screen.getByRole("group", { name: "Project archive filter" })).getByRole("button", { name: "Active" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("heading", { name: "Planning" })).toBeTruthy();
});

it("pins the default selected project in the URL before filtering", async () => {
  searchParams = "archived=false";
  renderPage();
  await screen.findByRole("heading", { name: "Planning" });
  expect(navigation.replacements).toContain("/projects?archived=false&project=p1");
});

it("keeps a failed create name and prevents duplicate submissions while pending", async () => {
  let reject!: (error: Error) => void;
  vi.mocked(api.createProject).mockImplementation(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
  renderPage();
  await screen.findByRole("heading", { name: "Planning" });
  const input = screen.getByRole("textbox", { name: "New project" });
  fireEvent.change(input, { target: { value: "New work" } });
  fireEvent.click(screen.getByRole("button", { name: "Create project" }));
  fireEvent.click(await screen.findByRole("button", { name: "Creating..." }));
  expect(api.createProject).toHaveBeenCalledTimes(1);
  await act(async () => reject(new Error("Creation failed")));
  await screen.findByText("Creation failed");
  expect((input as HTMLInputElement).value).toBe("New work");
  expect(screen.getByRole("button", { name: "Create project" }).hasAttribute("disabled")).toBe(false);
});
