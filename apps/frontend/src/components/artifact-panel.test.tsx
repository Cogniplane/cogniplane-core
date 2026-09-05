// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Artifact } from "@cogniplane/shared-types";

import { ArtifactPanel } from "./artifact-panel";

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
