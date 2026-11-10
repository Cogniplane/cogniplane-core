import { test, expect, vi } from "vitest";

import { ArtifactPreviewTooLargeError, TEXT_PREVIEW_MAX_BYTES } from "./artifact-preview";
import { loadArtifactPreview, type ArtifactPreviewLoaderDeps } from "./artifact-preview-loader";

function makeDeps(overrides: Partial<ArtifactPreviewLoaderDeps> = {}): ArtifactPreviewLoaderDeps {
  return {
    createDownload: vi.fn(async () => ({
      token: "tok",
      url: "/downloads/tok",
      expiresAt: "2026-05-31T00:00:00.000Z"
    })),
    fetchPreviewText: vi.fn(async () => "PDF TEXT"),
    fetchContent: vi.fn(async () => "RAW TEXT"),
    apiBase: () => "https://api.test",
    ...overrides
  };
}

test("image artifact → signed download URL, no text fetch", async () => {
  const deps = makeDeps();
  const result = await loadArtifactPreview(
    { artifactId: "a1", mimeType: "image/png", fileSizeBytes: 2048 },
    deps
  );

  expect(result).toEqual({ kind: "image", imageUrl: "https://api.test/downloads/tok" });
  expect(deps.createDownload).toHaveBeenCalledWith("a1");
  expect(deps.fetchPreviewText).not.toHaveBeenCalled();
  expect(deps.fetchContent).not.toHaveBeenCalled();
});

test("pdf artifact → server-extracted preview text, no download token", async () => {
  const deps = makeDeps();
  const result = await loadArtifactPreview(
    { artifactId: "a2", mimeType: "application/pdf", fileSizeBytes: 2048 },
    deps
  );

  expect(result).toEqual({ kind: "text", text: "PDF TEXT" });
  expect(deps.fetchPreviewText).toHaveBeenCalledWith("a2");
  expect(deps.createDownload).not.toHaveBeenCalled();
  expect(deps.fetchContent).not.toHaveBeenCalled();
});

test("other artifact → signed URL then raw content fetch within the size limit", async () => {
  const deps = makeDeps();
  const result = await loadArtifactPreview(
    { artifactId: "a3", mimeType: "text/markdown", fileSizeBytes: 2048 },
    deps
  );

  expect(result).toEqual({ kind: "text", text: "RAW TEXT" });
  expect(deps.createDownload).toHaveBeenCalledWith("a3");
  expect(deps.fetchContent).toHaveBeenCalledWith(
    "https://api.test/downloads/tok",
    TEXT_PREVIEW_MAX_BYTES
  );
  expect(deps.fetchPreviewText).not.toHaveBeenCalled();
});

test("text artifact at the size limit → still previewed", async () => {
  const deps = makeDeps();
  const result = await loadArtifactPreview(
    { artifactId: "a5", mimeType: "text/csv", fileSizeBytes: TEXT_PREVIEW_MAX_BYTES },
    deps
  );

  expect(result).toEqual({ kind: "text", text: "RAW TEXT" });
});

test("text artifact over the size limit → refused before a download token is minted", async () => {
  const deps = makeDeps();

  await expect(
    loadArtifactPreview(
      { artifactId: "a6", mimeType: "application/json", fileSizeBytes: TEXT_PREVIEW_MAX_BYTES + 1 },
      deps
    )
  ).rejects.toBeInstanceOf(ArtifactPreviewTooLargeError);
  expect(deps.createDownload).not.toHaveBeenCalled();
  expect(deps.fetchContent).not.toHaveBeenCalled();
});

test("image and PDF artifacts over the text size limit keep their preview flow", async () => {
  const deps = makeDeps();
  const size = TEXT_PREVIEW_MAX_BYTES * 20;

  await expect(
    loadArtifactPreview({ artifactId: "a7", mimeType: "image/png", fileSizeBytes: size }, deps)
  ).resolves.toEqual({ kind: "image", imageUrl: "https://api.test/downloads/tok" });
  await expect(
    loadArtifactPreview({ artifactId: "a8", mimeType: "application/pdf", fileSizeBytes: size }, deps)
  ).resolves.toEqual({ kind: "text", text: "PDF TEXT" });
  expect(deps.fetchContent).not.toHaveBeenCalled();
});

test("propagates loader errors so the hook can surface a preview error", async () => {
  const deps = makeDeps({
    fetchPreviewText: vi.fn(async () => {
      throw new Error("extraction failed");
    })
  });

  await expect(
    loadArtifactPreview({ artifactId: "a4", mimeType: "application/pdf", fileSizeBytes: 2048 }, deps)
  ).rejects.toThrow("extraction failed");
});
