import { test, expect, vi } from "vitest";

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
    { artifactId: "a1", mimeType: "image/png" },
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
    { artifactId: "a2", mimeType: "application/pdf" },
    deps
  );

  expect(result).toEqual({ kind: "text", text: "PDF TEXT" });
  expect(deps.fetchPreviewText).toHaveBeenCalledWith("a2");
  expect(deps.createDownload).not.toHaveBeenCalled();
  expect(deps.fetchContent).not.toHaveBeenCalled();
});

test("other artifact → signed URL then raw content fetch", async () => {
  const deps = makeDeps();
  const result = await loadArtifactPreview(
    { artifactId: "a3", mimeType: "text/markdown" },
    deps
  );

  expect(result).toEqual({ kind: "text", text: "RAW TEXT" });
  expect(deps.createDownload).toHaveBeenCalledWith("a3");
  expect(deps.fetchContent).toHaveBeenCalledWith("https://api.test/downloads/tok");
  expect(deps.fetchPreviewText).not.toHaveBeenCalled();
});

test("propagates loader errors so the hook can surface a preview error", async () => {
  const deps = makeDeps({
    fetchPreviewText: vi.fn(async () => {
      throw new Error("extraction failed");
    })
  });

  await expect(
    loadArtifactPreview({ artifactId: "a4", mimeType: "application/pdf" }, deps)
  ).rejects.toThrow("extraction failed");
});
