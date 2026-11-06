// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { WorkspaceSidebarFrame } from "./workspace-sidebar-frame";

afterEach(cleanup);

it("removes the collapsed desktop rail from keyboard and screen-reader navigation", () => {
  const { rerender } = render(
    <WorkspaceSidebarFrame mobile={false} open={false} onOpenChange={() => {}}>
      <a href="/settings">Settings</a>
    </WorkspaceSidebarFrame>
  );
  const link = screen.getByText("Settings");
  expect(link.closest("[inert]")).not.toBeNull();
  expect(link.closest('[aria-hidden="true"]')).not.toBeNull();
  rerender(
    <WorkspaceSidebarFrame mobile={false} open onOpenChange={() => {}}>
      <a href="/settings">Settings</a>
    </WorkspaceSidebarFrame>
  );
  expect(link.closest("[inert]")).toBeNull();
  expect(screen.getByRole("link", { name: "Settings" })).toBe(link);
});

it("opens a named phone dialog, focuses navigation, and restores the trigger after Escape", async () => {
  function Workspace() {
    const [open, setOpen] = useState(false);
    return <>
      <button data-workspace-sidebar-trigger onClick={() => setOpen(true)}>Show sidebar</button>
      <WorkspaceSidebarFrame mobile open={open} onOpenChange={setOpen}>
        <input aria-label="Search sessions" />
        <a href="/settings">Settings</a>
      </WorkspaceSidebarFrame>
    </>;
  }
  render(<Workspace />);
  const trigger = screen.getByRole("button", { name: "Show sidebar" });
  fireEvent.click(trigger);
  const dialog = await screen.findByRole("dialog", { name: "Sessions" });
  expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Search sessions" })));
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});
