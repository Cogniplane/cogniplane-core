// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceHeader } from "./workspace-header";
import { useState } from "react";
import { AlertDialog, AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogCancel } from "./ui/alert-dialog";

vi.mock("../lib/auth-context", () => ({ useAuth: () => ({ user: { displayName: "Ada" } }) }));
vi.mock("../hooks/use-organizations", () => ({ useOrganizations: () => [] }));
vi.mock("./theme-toggle", () => ({ ThemeToggle: () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { toast } from "sonner";
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("returns focus to session actions when a menu-opened confirmation is cancelled", async () => {
  function Confirmation() {
    const [open, setOpen] = useState(false);
    return <>
      <WorkspaceHeader title="Research" destinations={[]} sessionActions={{
        sessionId: "session-2", sessionName: "Research", isPinned: false, busy: false,
        isRunning: false, hasPendingApprovals: false, onTogglePin: vi.fn(), onDelete: () => setOpen(true)
      }} />
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogTitle>Move this session to Trash?</AlertDialogTitle>
          <AlertDialogDescription>The session can be restored.</AlertDialogDescription>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
        </AlertDialogContent>
      </AlertDialog>
    </>;
  }
  render(<Confirmation />);
  await choose("Delete session");
  fireEvent.keyDown(await screen.findByRole("alertdialog"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Session actions for Research" })));
});

it("keeps a title edit and focus when the header changes layout", () => {
  let width = 1000;
  let resize: (() => void) | undefined;
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect() {}
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ width }) as DOMRect);
  try {
    const save = vi.fn();
    render(<WorkspaceHeader title="Original" destinations={[]} onRenameSession={save} />);
    const title = screen.getByRole("textbox", { name: "Session title" });
    title.focus();
    title.textContent = "Draft title";
    fireEvent.input(title);
    width = 390;
    act(() => resize?.());
    const movedTitle = screen.getByRole("textbox", { name: "Session title" });
    expect(movedTitle.textContent).toBe("Draft title");
    expect(document.activeElement).toBe(movedTitle);
    fireEvent.keyDown(movedTitle, { key: "Enter" });
    expect(save).toHaveBeenCalledWith("Draft title");
  } finally { vi.unstubAllGlobals(); }
});

it.each(["approval", "failed"] as const)("keeps %s text visible on a 320px header", (status) => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 320 } as DOMRect);
  try {
    render(<WorkspaceHeader title="Research" destinations={[]} sessionStatus={status} />);
    const label = screen.getByText(status === "approval" ? "Waiting for approval" : "Failed");
    expect(label.classList.contains("sr-only")).toBe(false);
  } finally { vi.unstubAllGlobals(); }
});

function setup() {
  const actions = {
    sessionId: "session-2", sessionName: "Research", isPinned: true, busy: false,
    isRunning: false, hasPendingApprovals: false,
    onTogglePin: vi.fn(), onArchive: vi.fn(), onDelete: vi.fn()
  };
  const onRename = vi.fn();
  render(<WorkspaceHeader title="Research" destinations={[]} sessionActions={actions} onRenameSession={onRename} />);
  return { actions, onRename };
}
async function choose(name: string) {
  fireEvent.keyDown(screen.getByRole("button", { name: "Session actions for Research" }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name }));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
}
it("focuses the title for rename and forwards session actions", async () => {
  const { actions, onRename } = setup();
  await choose("Rename session");
  const title = screen.getByRole("textbox", { name: "Session title" });
  await waitFor(() => expect(document.activeElement).toBe(title));
  title.textContent = "Updated";
  fireEvent.input(title);
  fireEvent.blur(title);
  expect(onRename).toHaveBeenCalledWith("Updated");
  await choose("Unpin session");
  expect(actions.onTogglePin).toHaveBeenCalledOnce();
  await choose("Archive session");
  expect(actions.onArchive).toHaveBeenCalledOnce();
  await choose("Delete session");
  expect(actions.onDelete).toHaveBeenCalledOnce();
});
it("copies the selected session link and reports clipboard failure", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  setup();
  await choose("Copy session link");
  expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/?session=session-2`);
  expect(toast.success).toHaveBeenCalledWith("Session link copied");
  writeText.mockRejectedValueOnce(new Error("Denied"));
  await choose("Copy session link");
  expect(toast.error).toHaveBeenCalledWith("Could not copy session link");
});

it("keeps typed text when polling changes the title, then commits the visible edit", () => {
  const onRenameSession = vi.fn();
  const view = render(<WorkspaceHeader title="Original" destinations={[]} onRenameSession={onRenameSession} />);
  const title = screen.getByRole("textbox", { name: "Session title" });
  title.focus();
  title.textContent = "My edit";
  fireEvent.input(title);
  view.rerender(<WorkspaceHeader title="Renamed remotely" destinations={[]} onRenameSession={onRenameSession} />);
  expect(title.textContent).toBe("My edit");
  fireEvent.blur(title);
  expect(onRenameSession).toHaveBeenCalledWith("My edit");
});

it("cancels a rename to the latest server title without saving", () => {
  const onRenameSession = vi.fn();
  const view = render(<WorkspaceHeader title="Original" destinations={[]} onRenameSession={onRenameSession} />);
  const title = screen.getByRole("textbox", { name: "Session title" });
  title.focus();
  title.textContent = "My edit";
  view.rerender(<WorkspaceHeader title="Renamed remotely" destinations={[]} onRenameSession={onRenameSession} />);
  fireEvent.keyDown(title, { key: "Escape" });
  expect(title.textContent).toBe("Renamed remotely");
  expect(onRenameSession).not.toHaveBeenCalled();
});

it("keeps every control on a narrow header and moves copy and theme into menus", async () => {
  // jsdom has no layout: report a 390px header so the header picks its narrow layout.
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 390 } as DOMRect);
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const actions = {
    sessionId: "session-2", sessionName: "Research", isPinned: false, busy: false,
    isRunning: false, hasPendingApprovals: true, onTogglePin: vi.fn()
  };
  try {
    render(<WorkspaceHeader title="A long session title that cannot fit beside every control" destinations={[]}
      sessionActions={actions} sessionStatus="approval" hasPendingApprovals
      onToggleSidebar={vi.fn()} onToggleArtifactPane={vi.fn()} onCopySession={() => "transcript"} />);
    for (const name of ["Show sidebar", "Session capabilities", "Session actions for Research", "Jump to…", /Open account menu/]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    // The approval stays visible in two ways: the status and the artifacts button name.
    expect(screen.getByRole("img", { name: "Waiting for approval" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show artifacts panel, approval waiting" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy session to clipboard" })).toBeNull();

    await choose("Copy session to clipboard");
    expect(writeText).toHaveBeenCalledWith("transcript");
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Session copied"));

    fireEvent.keyDown(screen.getByRole("button", { name: /Open account menu/ }), { key: "Enter" });
    expect(await screen.findByRole("menuitem", { name: /Switch to (dark|light) theme/ })).toBeTruthy();
  } finally {
    vi.unstubAllGlobals();
  }
});
