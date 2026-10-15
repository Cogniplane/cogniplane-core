// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { FileSourcePicker, type FileSourceDefinition } from "./file-source-picker";

afterEach(cleanup);

function source(id: string, label: string, connected: boolean): FileSourceDefinition {
  return {
    id,
    label,
    description: `${label} files`,
    connection: connected
      ? { kind: "connected", label: `Signed in to ${label}` }
      : { kind: "disconnected", label: `Connect ${label} first.`, settingsHref: `/settings/${id}` },
    renderBody: ({ selectedSessionId }) => <p>{`${label} browser for ${selectedSessionId ?? "no session"}`}</p>
  };
}

function renderPicker(props: Partial<Parameters<typeof FileSourcePicker>[0]> = {}) {
  const handlers = { onClose: vi.fn(), onSelectSource: vi.fn() };
  render(<FileSourcePicker isOpen selectedSessionId="s1" sources={[]} activeSourceId={null} {...handlers} {...props} />);
  return handlers;
}

it("says when no source is available", () => {
  renderPicker();

  expect(screen.getByText("No sources available")).toBeTruthy();
  expect(screen.queryByRole("tablist")).toBeNull();
});

it("shows a single connected source directly, without tabs", () => {
  renderPicker({ sources: [source("drive", "Google Drive", true)] });

  expect(screen.getByText("Google Drive browser for s1")).toBeTruthy();
  expect(screen.queryByRole("tablist")).toBeNull();
});

it("sends a single disconnected source to its settings", () => {
  renderPicker({ sources: [source("drive", "Google Drive", false)], selectedSessionId: null });

  expect(screen.getByText("Google Drive not connected")).toBeTruthy();
  expect(screen.getByText("Connect Google Drive first.")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open Google Drive settings" }).getAttribute("href")).toBe("/settings/drive");
  expect(screen.queryByText(/browser for/)).toBeNull();
});

it("opens the active source's tab and reports a tab change", () => {
  const { onSelectSource } = renderPicker({
    sources: [source("drive", "Google Drive", true), source("sharepoint", "SharePoint", false)],
    activeSourceId: "sharepoint"
  });

  expect(screen.getByRole("tab", { name: /SharePoint/ }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("tab", { name: /Google Drive/ }).textContent).toContain("Signed in to Google Drive");
  expect(screen.getByRole("tab", { name: /SharePoint/ }).textContent).toContain("Not connected");
  expect(screen.getByRole("tabpanel").textContent).toContain("SharePoint not connected");

  fireEvent.mouseDown(screen.getByRole("tab", { name: /Google Drive/ }), { button: 0 });
  expect(onSelectSource).toHaveBeenCalledWith("drive");
});

it("falls back to the first tab when the active source is unknown", () => {
  renderPicker({
    sources: [source("drive", "Google Drive", true), source("sharepoint", "SharePoint", true)],
    activeSourceId: "removed"
  });

  expect(screen.getByRole("tab", { name: /Google Drive/ }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("tabpanel").textContent).toBe("Google Drive browser for s1");
});

it("closes on Escape", () => {
  const { onClose } = renderPicker();

  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

  expect(onClose).toHaveBeenCalledTimes(1);
});
