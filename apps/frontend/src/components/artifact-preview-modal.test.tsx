// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";

import { ArtifactPreviewModal } from "./artifact-preview-modal";
import { SHORTCUTS, useShortcut } from "../lib/keyboard-shortcuts";

afterEach(cleanup);

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
