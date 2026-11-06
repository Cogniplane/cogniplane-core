// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Artifact } from "@cogniplane/shared-types";

import { ArtifactPanel } from "./artifact-panel";
import { registerArtifactOrigin } from "../lib/artifact-origins";

afterEach(cleanup);

const artifact: Artifact = {
  artifactId: "artifact-1",
  sessionId: "session-1",
  userId: "user-1",
  artifactType: "upload",
  sourceArtifactId: null,
  artifactName: "notes.txt",
  mimeType: "text/plain",
  storageBackend: "local",
  storageKey: "artifact-1/notes.txt",
  fileSizeBytes: 42,
  checksumSha256: "checksum",
  status: "ready",
  createdByType: "user",
  createdByRef: "user-1",
  detail: {},
  createdAt: "2026-09-04T12:00:00.000Z",
  updatedAt: "2026-09-04T12:00:00.000Z"
};

it("routes selection, preview, download, and source actions through their owners", async () => {
  const onToggleSelection = vi.fn();
  const onPreview = vi.fn();
  const onDownload = vi.fn();
  const onUpload = vi.fn();
  const onOpenFileSource = vi.fn();
  const view = render(
    <ArtifactPanel
      surface="raised"
      inventory={{ artifacts: [artifact] }}
      selection={{ visibleSelectedArtifactIds: ["artifact-1"], onToggle: onToggleSelection }}
      transfers={{ isUploading: false, downloadingId: null, onUpload, onDownload }}
      preview={{ artifactId: null, isLoading: false, onOpen: onPreview }}
      sources={{
        sessionId: "session-1",
        items: [{ id: "drive", label: "Drive", description: "Cloud files", connection: { kind: "connected", label: "Connected" } }],
        onOpen: onOpenFileSource
      }}
    />
  );

  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  fireEvent.click(screen.getByRole("button", { name: "Download" }));
  expect(onToggleSelection).toHaveBeenCalledWith("artifact-1");
  expect(onPreview).toHaveBeenCalledWith("artifact-1");
  expect(onDownload).toHaveBeenCalledWith("artifact-1");

  const upload = view.container.querySelector('input[type="file"]');
  const file = new File(["hello"], "hello.txt", { type: "text/plain" });
  fireEvent.change(upload!, { target: { files: [file] } });
  expect(onUpload).toHaveBeenCalledWith(file);

  fireEvent.pointerDown(screen.getByRole("button", { name: /Add source/ }), {
    button: 0,
    ctrlKey: false
  });
  fireEvent.click(await screen.findByText("Drive"));
  expect(onOpenFileSource).toHaveBeenCalledWith("drive");

  view.rerender(
    <ArtifactPanel
      inventory={{ artifacts: [artifact] }}
      selection={{ visibleSelectedArtifactIds: ["artifact-1"], onToggle: onToggleSelection }}
      transfers={{ isUploading: true, downloadingId: null, onUpload, onDownload }}
      preview={{ artifactId: null, isLoading: false, onOpen: onPreview }}
      sources={{ sessionId: "session-1", items: [], onOpen: onOpenFileSource }}
    />
  );
  expect(screen.getByRole("button", { name: "Uploading..." }).hasAttribute("disabled")).toBe(true);
});

it("shows the label and tone of a registered artifact origin", () => {
  const panel = (artifacts: Artifact[]) => (
    <ArtifactPanel
      inventory={{ artifacts }}
      selection={{ visibleSelectedArtifactIds: ["artifact-1"], onToggle: vi.fn() }}
      transfers={{ isUploading: false, downloadingId: null, onUpload: vi.fn(), onDownload: vi.fn() }}
      preview={{ artifactId: null, isLoading: false, onOpen: vi.fn() }}
      sources={{ sessionId: "session-1", items: [], onOpen: vi.fn() }}
    />
  );
  const imported = { ...artifact, detail: { source: "example-drive" } };

  // No overlay registered the source: the core label shows.
  const view = render(panel([imported]));
  expect(screen.getByText("Uploaded").className).toContain("bg-[var(--artifact-chip-surface)]");

  registerArtifactOrigin({ detailSource: "example-drive", label: "Example import", tone: "accent" });
  view.rerender(panel([imported]));
  expect(screen.getByText("Example import").className).toContain("bg-info-surface");
});

it("does not report an empty session while the files are unknown", () => {
  const panel = (status: "ready" | "loading" | "unavailable") => (
    <ArtifactPanel
      inventory={{ artifacts: [], status }}
      selection={{ visibleSelectedArtifactIds: [], onToggle: vi.fn() }}
      transfers={{ isUploading: false, downloadingId: null, onUpload: vi.fn(), onDownload: vi.fn() }}
      preview={{ artifactId: null, isLoading: false, onOpen: vi.fn() }}
      sources={{ sessionId: "session-1", items: [], onOpen: vi.fn() }}
    />
  );
  const tabCounts = () => screen.getAllByRole("tab").map((tab) => tab.textContent);

  const view = render(panel("loading"));
  expect(screen.getByRole("status").textContent).toBe("Loading files…");
  expect(screen.queryByText("No documents in play")).toBeNull();
  expect(tabCounts()).toEqual(["Context–", "Artifacts–"]);

  view.rerender(panel("unavailable"));
  expect(screen.getByText("Files did not load")).toBeTruthy();
  expect(screen.queryByText("No documents in play")).toBeNull();
  expect(tabCounts()).toEqual(["Context–", "Artifacts–"]);

  view.rerender(panel("ready"));
  expect(screen.getByText("No documents in play")).toBeTruthy();
  expect(tabCounts()).toEqual(["Context0", "Artifacts0"]);
});

it("offers file recovery in the panel without a chat-area Retry", () => {
  const onRetry = vi.fn();
  const panel = (retrying: boolean) => <ArtifactPanel
    inventory={{ artifacts: [], status: "unavailable", onRetry, retrying }}
    selection={{ visibleSelectedArtifactIds: [], onToggle: vi.fn() }}
    transfers={{ isUploading: false, downloadingId: null, onUpload: vi.fn(), onDownload: vi.fn() }}
    preview={{ artifactId: null, isLoading: false, onOpen: vi.fn() }}
    sources={{ sessionId: "session-1", items: [], onOpen: vi.fn() }} />;
  const view = render(panel(false));
  const retry = screen.getByRole("button", { name: "Try again" });
  retry.focus();
  fireEvent.click(retry);
  expect(onRetry).toHaveBeenCalledOnce();
  view.rerender(panel(true));
  expect(screen.getByRole("button", { name: "Retrying…" })).toBe(retry);
  expect(document.activeElement).toBe(retry);
  fireEvent.click(retry);
  expect(onRetry).toHaveBeenCalledOnce();
});
