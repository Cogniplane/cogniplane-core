// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";

// Markdown that contains this marker makes the renderer throw, as a broken
// third-party renderer would.
vi.mock("./safe-markdown", async (importOriginal) => {
  const original = await importOriginal<typeof import("./safe-markdown")>();
  return {
    ...original,
    SafeMarkdown: (props: Parameters<typeof original.SafeMarkdown>[0]) => {
      if (typeof props.children === "string" && props.children.includes("BROKEN-RENDER")) {
        throw new Error("BROKEN-RENDER secret file text");
      }
      return <original.SafeMarkdown {...props} />;
    }
  };
});

import { ArtifactPreviewModal } from "./artifact-preview-modal";
import { SHORTCUTS, useShortcut } from "../lib/keyboard-shortcuts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Preview({ onStop }: { onStop: () => void }) {
  const [open, setOpen] = useState(false);
  useShortcut(SHORTCUTS.stop, onStop);
  return <>
    <button type="button" onClick={() => setOpen(true)}>Preview report</button>
    {open ? <ArtifactPreviewModal artifactName="Report.html" mimeType="text/html"
      content="<h1>Report</h1><a href='#notes'>Notes</a>" imageUrl={null} error={null}
      onClose={() => setOpen(false)} /> : null}
  </>;
}

it("starts HTML preview on Close so Escape dismisses the preview and restores its opener", async () => {
  const onStop = vi.fn();
  render(<Preview onStop={onStop} />);
  const opener = screen.getByRole("button", { name: "Preview report" });
  opener.focus();
  fireEvent.click(opener);
  const close = await screen.findByRole("button", { name: "Close" });
  await waitFor(() => expect(document.activeElement).toBe(close));
  const frame = screen.getByTitle("Report.html");
  expect(frame.getAttribute("sandbox")).toBe("");
  expect(frame.getAttribute("srcdoc")).toContain("default-src 'none'");

  expect(fireEvent.keyDown(close, { key: "Escape" })).toBe(false);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(onStop).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(opener);
});


it("announces async failure and offers an optional local retry", () => {
  const onRetry = vi.fn();
  render(<ArtifactPreviewModal artifactName="Report.md" mimeType="text/markdown" content={null} imageUrl={null}
    error="The preview could not load." onClose={vi.fn()} onRetry={onRetry} />);
  expect(screen.getByRole("alert").textContent).toBe("The preview could not load.");
  fireEvent.click(screen.getByRole("button", { name: "Retry preview" }));
  expect(onRetry).toHaveBeenCalledTimes(1);
});

it("keeps existing callers compatible when no local retry is supplied", () => {
  render(<ArtifactPreviewModal artifactName="Report.md" mimeType="text/markdown" content={null} imageUrl={null}
    error="The preview could not load." onClose={vi.fn()} />);
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Retry preview" })).toBeNull();
});

it("keeps the title and Close usable when the preview content fails to render", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const onClose = vi.fn();
  const view = render(<ArtifactPreviewModal artifactName="Notes.md" mimeType="text/markdown"
    content={"# Notes\n\nBROKEN-RENDER"} imageUrl={null} error={null} onClose={onClose} />);

  const dialog = screen.getByRole("dialog", { name: "Notes.md" });
  const failure = within(dialog).getByRole("alert");
  expect(failure.textContent).toContain("This preview could not be shown");
  expect(dialog.textContent).not.toContain("secret file text");

  // The saved content still fails, so Try again shows the same notice.
  fireEvent.click(within(failure).getByRole("button", { name: "Try again" }));
  expect(within(dialog).getByRole("alert")).toBeTruthy();

  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  expect(onClose).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(2);

  // Another file in the same dialog renders: the failure belongs to the file.
  view.rerender(<ArtifactPreviewModal artifactName="Plan.md" mimeType="text/markdown"
    content="Plan text" imageUrl={null} error={null} onClose={onClose} />);
  expect(await screen.findByText("Plan text")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});
