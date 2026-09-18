// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceHeader } from "./workspace-header";

vi.mock("../lib/auth-context", () => ({ useAuth: () => ({ user: { displayName: "Ada" } }) }));
vi.mock("../hooks/use-organizations", () => ({ useOrganizations: () => [] }));
vi.mock("./theme-toggle", () => ({ ThemeToggle: () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { toast } from "sonner";
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function setup() {
  const actions = {
    sessionId: "session-2", sessionName: "Research", isPinned: true, busy: false,
    isRunning: false, hasPendingApprovals: false,
    onTogglePin: vi.fn(), onArchive: vi.fn(), onDelete: vi.fn()
  };
  const onRename = vi.fn();
  render(<WorkspaceHeader title="Research" menuLinks={[]} sessionActions={actions} onRenameSession={onRename} />);
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
  const view = render(<WorkspaceHeader title="Original" menuLinks={[]} onRenameSession={onRenameSession} />);
  const title = screen.getByRole("textbox", { name: "Session title" });
  title.focus();
  title.textContent = "My edit";
  fireEvent.input(title);
  view.rerender(<WorkspaceHeader title="Renamed remotely" menuLinks={[]} onRenameSession={onRenameSession} />);
  expect(title.textContent).toBe("My edit");
  fireEvent.blur(title);
  expect(onRenameSession).toHaveBeenCalledWith("My edit");
});

it("cancels a rename to the latest server title without saving", () => {
  const onRenameSession = vi.fn();
  const view = render(<WorkspaceHeader title="Original" menuLinks={[]} onRenameSession={onRenameSession} />);
  const title = screen.getByRole("textbox", { name: "Session title" });
  title.focus();
  title.textContent = "My edit";
  view.rerender(<WorkspaceHeader title="Renamed remotely" menuLinks={[]} onRenameSession={onRenameSession} />);
  fireEvent.keyDown(title, { key: "Escape" });
  expect(title.textContent).toBe("Renamed remotely");
  expect(onRenameSession).not.toHaveBeenCalled();
});
