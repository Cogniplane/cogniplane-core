// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { Project } from "@cogniplane/shared-types";
import * as api from "../../lib/project-api";
import Page from "./page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams("project=p1")
}));
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
  getProjectAccess: vi.fn(),
  archiveProject: vi.fn(),
  createProject: vi.fn()
}));
vi.mock("../../lib/session-api", () => ({ listSessions: async () => [] }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

const time = "2026-09-13T00:00:00Z";
let project: Project;
let client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
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
  vi.mocked(api.getProject).mockImplementation(async () => ({
    project: { ...project },
    sessions: [],
    files: [],
    canManage: true
  }));
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

it("moves an archived project out of Active and restores it through the Archived view", async () => {
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "Archive project" }));
  await screen.findByRole("heading", { name: "Give ongoing work a home" });
  expect(screen.queryByRole("heading", { name: "Planning" })).toBeNull();
  expect(toast.success).toHaveBeenCalledWith(
    "Project moved to Archived. Restore it to return its sessions to the main screen."
  );
  fireEvent.click(screen.getByRole("button", { name: "Archived" }));
  fireEvent.click(await screen.findByRole("button", { name: "Restore project" }));
  await screen.findByRole("heading", { name: "No archived projects" });
  fireEvent.click(screen.getByRole("button", { name: "Active" }));
  await screen.findByRole("button", { name: "Archive project" });
  expect(api.archiveProject).toHaveBeenNthCalledWith(1, "p1", true);
  expect(api.archiveProject).toHaveBeenNthCalledWith(2, "p1", false);
});

it("keeps the project visible and reports an archive failure", async () => {
  vi.mocked(api.archiveProject).mockRejectedValueOnce(new Error("Archive failed"));
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "Archive project" }));
  await screen.findByText("Archive failed");
  expect(screen.getByRole("heading", { name: "Planning" })).toBeTruthy();
  expect(toast.success).not.toHaveBeenCalled();
});

it("debounces server searches while updating the input immediately", async () => {
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
