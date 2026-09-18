// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Project, Session } from "@cogniplane/shared-types";

import { SessionSidebar } from "./session-sidebar";
import { deriveAttentionSessionIds } from "./session-list-derivations";

vi.mock("next/image", () => ({ default: (props: Record<string, unknown>) => <span role="img" aria-label={String(props.alt)} /> }));
vi.mock("next/link", () => ({ default: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("../lib/auth-context", () => ({ useAuth: () => ({ user: { displayName: "Ada", email: "ada@example.com" } }) }));
vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
afterEach(cleanup);

const session: Session = {
  sessionId: "session-1",
  userId: "user-1",
  sessionName: "Research notes",
  status: "active",
  purpose: "normal",
  createdAt: "2026-09-04T12:00:00.000Z",
  updatedAt: new Date().toISOString()
};

const project: Project = {
  projectId: "project-1",
  name: "Launch plan",
  instructions: "",
  instructionsRevision: 0,
  referenceSessionId: "reference-1",
  approvalMode: "organization_default",
  agentFileMode: "read-only",
  archivedAt: null,
  createdAt: "2026-09-01T12:00:00.000Z",
  updatedAt: "2026-09-04T12:00:00.000Z"
};
const archivedProject: Project = {
  ...project,
  projectId: "archived-project",
  name: "Old project",
  archivedAt: "2026-09-10T12:00:00.000Z"
};

it("promotes pending sessions above pins, filters them, and restores their groups after resolution", () => {
  const sessions: Session[] = [
    { ...session, sessionId: "pinned", sessionName: "Pinned work" },
    { ...session, sessionId: "running", sessionName: "Running work", isRunning: true },
    { ...session, sessionId: "approval", sessionName: "Approval work", hasPendingApprovals: true },
    { ...session, sessionId: "live", sessionName: "Live work", purpose: "skill_improvement" }
  ];
  const props = {
    list: { sessions, selectedId: "live", isLoading: false, streamingIds: new Set(["running"]), attentionIds: deriveAttentionSessionIds(sessions, "live", 1), errorId: null, onSelect: vi.fn(), onCreate: vi.fn() },
    rename: { busyId: null, sessionId: null, renameDraft: "", onStartRename: vi.fn(), onCancelRename: vi.fn(), onConfirmRename: vi.fn(), onRenameDraftChange: vi.fn() },
    deletion: { busyId: null, pendingId: null, onRequest: vi.fn(), onConfirmDelete: vi.fn(), onCancelDelete: vi.fn() },
    pinning: { busyId: null, ids: new Set(["pinned", "approval"]), onToggle: vi.fn() }
  };
  const view = render(<SessionSidebar {...props} />);
  const order = () => screen.getAllByRole("button", { name: /^(Pinned|Running|Approval|Live) work/ }).map((button) => button.textContent?.split("work")[0].trim());
  expect(order()).toEqual(["Approval", "Live", "Pinned", "Running"]);
  expect(screen.getByText("Needs attention").parentElement?.textContent).toBe("Needs attention2");
  expect(screen.getByRole("button", { name: /^Approval work/ }).querySelector('[aria-label="Pinned session"]')).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /^Live work/ }));
  expect(props.list.onSelect).toHaveBeenCalledWith("live");
  fireEvent.change(screen.getByRole("textbox", { name: "Search sessions" }), { target: { value: "live" } });
  expect(order()).toEqual(["Live"]);
  expect(screen.getByText("Needs attention").parentElement?.textContent).toBe("Needs attention1");
  fireEvent.change(screen.getByRole("textbox", { name: "Search sessions" }), { target: { value: "missing" } });
  expect(screen.queryByText("Needs attention")).toBeNull();
  expect(screen.getByText("No matches")).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox", { name: "Search sessions" }), { target: { value: "" } });
  const resolved = sessions.map((s) => ({ ...s, hasPendingApprovals: false }));
  view.rerender(<SessionSidebar {...props} list={{ ...props.list, sessions: resolved, attentionIds: deriveAttentionSessionIds(resolved, "live", 0) }} />);
  expect(screen.queryByText("Needs attention")).toBeNull();
  expect(order()).toEqual(["Pinned", "Approval", "Running", "Live"]);
  expect(screen.getByText("Pinned").parentElement?.textContent).toBe("Pinned2");
  expect(screen.getByText("Skill improvement")).toBeTruthy();
});

it("shows active projects and hides archived projects from the sidebar", async () => {
  const onCreate = vi.fn().mockResolvedValue(undefined);
  const onAddToProject = vi.fn().mockResolvedValue(undefined);
  const projectSession = { ...session, sessionId: "project-session", sessionName: "Launch research", projectId: project.projectId };
  const archivedSession = { ...session, sessionId: "archived-session", sessionName: "Old notes", projectId: archivedProject.projectId };
  render(
    <SessionSidebar
      projects={[project, archivedProject]}
      onAddToProject={onAddToProject}
      list={{ sessions: [session, projectSession, archivedSession], selectedId: null, isLoading: false, streamingIds: new Set(), errorId: null, attentionIds: new Set([projectSession.sessionId]), onSelect: vi.fn(), onCreate }}
      rename={{ busyId: null, sessionId: null, renameDraft: "", onStartRename: vi.fn(), onCancelRename: vi.fn(), onConfirmRename: vi.fn(), onRenameDraftChange: vi.fn() }}
      deletion={{ busyId: null, pendingId: null, onRequest: vi.fn(), onConfirmDelete: vi.fn(), onCancelDelete: vi.fn() }}
      pinning={{ busyId: null, ids: new Set([projectSession.sessionId]), onToggle: vi.fn() }}
    />
  );

  expect(screen.getByText("Launch plan")).toBeTruthy();
  expect(screen.queryByText("Old project")).toBeNull();
  expect(screen.queryByText("Old notes")).toBeNull();
  expect(screen.queryByText("Archived")).toBeNull();
  expect(screen.getByLabelText("1 session needing attention")).toBeTruthy();
  expect(screen.getByLabelText("1 pinned session")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Expand Launch plan" }));
  expect(screen.getByRole("button", { name: /^Launch research/ })).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "New session" }));
  fireEvent.change(screen.getByLabelText("Project"), { target: { value: project.projectId } });
  fireEvent.click(screen.getByRole("button", { name: "Create session" }));
  await waitFor(() => expect(onCreate).toHaveBeenCalledWith(project.projectId));

  fireEvent.keyDown(screen.getByRole("button", { name: "Session actions for Research notes" }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Add to project" }));
  fireEvent.click(screen.getByRole("button", { name: "Add to project" }));
  await waitFor(() => expect(onAddToProject).toHaveBeenCalledWith("session-1", project.projectId));
});

it("keeps the create dialog open and shows a creation error", async () => {
  const onCreate = vi.fn().mockRejectedValue(new Error("Session service unavailable"));
  render(
    <SessionSidebar
      list={{ sessions: [session], selectedId: null, isLoading: false, streamingIds: new Set(), errorId: null, onSelect: vi.fn(), onCreate }}
      rename={{ busyId: null, sessionId: null, renameDraft: "", onStartRename: vi.fn(), onCancelRename: vi.fn(), onConfirmRename: vi.fn(), onRenameDraftChange: vi.fn() }}
      deletion={{ busyId: null, pendingId: null, onRequest: vi.fn(), onConfirmDelete: vi.fn(), onCancelDelete: vi.fn() }}
      pinning={{ busyId: null, ids: new Set(), onToggle: vi.fn() }}
    />
  );

  fireEvent.click(screen.getByRole("button", { name: "New session" }));
  fireEvent.click(screen.getByRole("button", { name: "Create session" }));

  expect((await screen.findByRole("alert")).textContent).toContain("Session service unavailable");
  expect(screen.getByRole("dialog")).toBeTruthy();
});

it("does not offer project assignment for non-normal sessions", async () => {
  render(
    <SessionSidebar
      projects={[project]}
      list={{ sessions: [{ ...session, purpose: "skill_improvement" }], selectedId: null, isLoading: false, streamingIds: new Set(), errorId: null, onSelect: vi.fn(), onCreate: vi.fn().mockResolvedValue(undefined) }}
      rename={{ busyId: null, sessionId: null, renameDraft: "", onStartRename: vi.fn(), onCancelRename: vi.fn(), onConfirmRename: vi.fn(), onRenameDraftChange: vi.fn() }}
      deletion={{ busyId: null, pendingId: null, onRequest: vi.fn(), onConfirmDelete: vi.fn(), onCancelDelete: vi.fn() }}
      pinning={{ busyId: null, ids: new Set(), onToggle: vi.fn() }}
    />
  );

  fireEvent.keyDown(screen.getByRole("button", { name: "Session actions for Research notes" }), { key: "Enter" });
  expect(screen.queryByRole("menuitem", { name: "Add to project" })).toBeNull();
});

it("routes select, pin, rename, and delete actions through their owners", async () => {
  const onSelect = vi.fn();
  const onTogglePin = vi.fn();
  const onStartRename = vi.fn();
  const onRequestDelete = vi.fn();
  const rename = { busyId: null, sessionId: null, renameDraft: "", onStartRename, onCancelRename: vi.fn(), onConfirmRename: vi.fn(), onRenameDraftChange: vi.fn() };
  const deletion = { busyId: null, pendingId: null, onRequest: onRequestDelete, onConfirmDelete: vi.fn(), onCancelDelete: vi.fn() };
  const view = render(
    <SessionSidebar
      list={{ sessions: [session], selectedId: null, isLoading: false, streamingIds: new Set(), attentionIds: new Set(), errorId: null, onSelect, onCreate: vi.fn() }}
      rename={rename}
      deletion={deletion}
      pinning={{ busyId: null, ids: new Set(), onToggle: onTogglePin }}
    />
  );
  fireEvent.click(screen.getByRole("button", { name: /^Research notes/ }));
  for (const name of ["Pin session", "Rename session", "Delete session"]) {
    fireEvent.keyDown(screen.getByRole("button", { name: /Session actions for/ }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  }
  await waitFor(() => expect(onStartRename).toHaveBeenCalledWith(session));
  expect(onSelect).toHaveBeenCalledWith("session-1");
  expect(onTogglePin).toHaveBeenCalledWith("session-1");
  expect(onRequestDelete).toHaveBeenCalledWith("session-1");

  view.rerender(
    <SessionSidebar
      list={{ sessions: [session], selectedId: null, isLoading: false, streamingIds: new Set(), attentionIds: new Set(), errorId: null, onSelect, onCreate: vi.fn() }}
      rename={rename}
      deletion={{ ...deletion, pendingId: "session-1" }}
      pinning={{ busyId: null, ids: new Set(), onToggle: onTogglePin }}
    />
  );
  fireEvent.click(screen.getByRole("button", { name: "Move to Trash" }));
  expect(deletion.onConfirmDelete).toHaveBeenCalledOnce();

  view.rerender(
    <SessionSidebar
      list={{ sessions: [session], selectedId: null, isLoading: false, streamingIds: new Set(), attentionIds: new Set(), errorId: null, onSelect, onCreate: vi.fn() }}
      rename={{ ...rename, sessionId: "session-1", renameDraft: "New title" }}
      deletion={deletion}
      pinning={{ busyId: null, ids: new Set(), onToggle: onTogglePin }}
    />
  );
  fireEvent.submit(screen.getByDisplayValue("New title").closest("form")!);
  expect(rename.onConfirmRename).toHaveBeenCalledWith("session-1");
});


it("archives idle sessions and disables archive for running turns and pending approvals", async () => {
  const onArchive = vi.fn();
  const props = {
    list: { sessions: [session], selectedId: null, isLoading: false, streamingIds: new Set<string>(), errorId: null, onSelect: vi.fn(), onCreate: vi.fn() },
    rename: { busyId: null, sessionId: null, renameDraft: "", onStartRename: vi.fn(), onCancelRename: vi.fn(), onConfirmRename: vi.fn(), onRenameDraftChange: vi.fn() },
    deletion: { busyId: null, pendingId: null, onRequest: vi.fn(), onConfirmDelete: vi.fn(), onCancelDelete: vi.fn() },
    pinning: { busyId: null, ids: new Set<string>(), onToggle: vi.fn() },
    archive: { busyId: null, onArchive }
  };
  const view = render(<SessionSidebar {...props} />);
  fireEvent.keyDown(screen.getByRole("button", { name: /Session actions for/ }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Archive session" }));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(onArchive).toHaveBeenCalledWith(session.sessionId);
  onArchive.mockClear();
  for (const state of [{ isRunning: true }, { hasPendingApprovals: true }]) {
    view.rerender(<SessionSidebar {...props} list={{ ...props.list, sessions: [{ ...session, ...state }] }} />);
    fireEvent.keyDown(screen.getByRole("button", { name: /Session actions for/ }), { key: "Enter" });
    const button = await screen.findByRole("menuitem", { name: "Archive session" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    const reason = screen.getByText("hasPendingApprovals" in state
      ? "Resolve pending approvals before archiving"
      : "Wait for the current turn to finish before archiving");
    expect(button.getAttribute("aria-describedby")).toBe(reason.id);
    fireEvent.click(button);
    expect(onArchive).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  }
  view.rerender(<SessionSidebar {...props} archive={{ ...props.archive, busyId: session.sessionId }} />);
  fireEvent.keyDown(screen.getByRole("button", { name: /Session actions for/ }), { key: "Enter" });
  const busyButton = await screen.findByRole("menuitem", { name: "Archive session" });
  expect(busyButton.getAttribute("aria-disabled")).toBe("true");
  expect(busyButton.getAttribute("aria-describedby")).toBe(screen.getByText("Wait for the current session change to finish").id);
});


it("shows stored failures for unselected sessions and clears them during retry", () => {
  const props = {
    list: { sessions: [{ ...session, hasTurnFailed: true }], selectedId: null, isLoading: false, streamingIds: new Set<string>(), errorId: null, onSelect: vi.fn(), onCreate: vi.fn() },
    rename: { busyId: null, sessionId: null, renameDraft: "", onStartRename: vi.fn(), onCancelRename: vi.fn(), onConfirmRename: vi.fn(), onRenameDraftChange: vi.fn() },
    deletion: { busyId: null, pendingId: null, onRequest: vi.fn(), onConfirmDelete: vi.fn(), onCancelDelete: vi.fn() },
    pinning: { busyId: null, ids: new Set<string>(), onToggle: vi.fn() }
  };
  const view = render(<SessionSidebar {...props} />);
  expect(screen.getByRole("img", { name: "Failed" })).toBeTruthy();
  view.rerender(<SessionSidebar {...props} list={{ ...props.list, streamingIds: new Set([session.sessionId]) }} />);
  expect(screen.queryByRole("img", { name: "Failed" })).toBeNull();
  expect(screen.getByRole("img", { name: "Running" })).toBeTruthy();
});
