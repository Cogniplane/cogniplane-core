// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Artifact } from "@cogniplane/shared-types";

import { ArtifactPreviewTooLargeError, TEXT_PREVIEW_TOO_LARGE_MESSAGE } from "../lib/artifact-preview";
import { useArtifactActions } from "./use-artifact-actions";

// vitest runs with globals:false, so RTL cannot auto-register its cleanup.
afterEach(cleanup);

const loaderState = vi.hoisted(() => ({
  pending: [] as Array<{
    artifactId: string;
    resolve: (result: { kind: "text"; text: string }) => void;
    reject: (error: unknown) => void;
  }>
}));

vi.mock("../lib/artifact-preview-loader", () => ({
  artifactApiBase: () => "http://test",
  loadArtifactPreview: vi.fn(
    (artifact: { artifactId: string }) =>
      new Promise((resolve, reject) => {
        loaderState.pending.push({ artifactId: artifact.artifactId, resolve, reject });
      })
  )
}));

vi.mock("../lib/artifact-api", () => ({
  createArtifactDownload: vi.fn(async () => ({ url: "/dl" }))
}));

function makeArtifact(artifactId: string): Artifact {
  return {
    artifactId,
    artifactName: `${artifactId}.txt`,
    mimeType: "text/plain",
    status: "ready"
  } as Artifact;
}

describe("useArtifactActions preview race guard", () => {
  beforeEach(() => {
    loaderState.pending.length = 0;
  });

  it("a superseded preview's settle does not clear the newer preview's loading state", async () => {
    const { result } = renderHook(() => useArtifactActions({ onError: vi.fn() }));

    await act(async () => {
      void result.current.openPreview(makeArtifact("a-1"));
    });
    await act(async () => {
      void result.current.openPreview(makeArtifact("a-2"));
    });
    expect(result.current.isLoadingPreview).toBe(true);

    // The first (stale) request settles while the second is still loading.
    await act(async () => {
      loaderState.pending[0]!.resolve({ kind: "text", text: "stale content" });
    });
    expect(result.current.isLoadingPreview).toBe(true);
    expect(result.current.previewContent).toBeNull();

    // The current request settles normally.
    await act(async () => {
      loaderState.pending[1]!.resolve({ kind: "text", text: "fresh content" });
    });
    expect(result.current.isLoadingPreview).toBe(false);
    expect(result.current.previewContent).toBe("fresh content");
    expect(result.current.previewArtifactId).toBe("a-2");
  });

  it("a single preview clears its own loading state when it settles", async () => {
    const { result } = renderHook(() => useArtifactActions({ onError: vi.fn() }));

    await act(async () => {
      void result.current.openPreview(makeArtifact("a-1"));
    });
    expect(result.current.isLoadingPreview).toBe(true);

    await act(async () => {
      loaderState.pending[0]!.resolve({ kind: "text", text: "content" });
    });
    expect(result.current.isLoadingPreview).toBe(false);
    expect(result.current.previewContent).toBe("content");
  });
});

describe("useArtifactActions preview errors", () => {
  beforeEach(() => {
    loaderState.pending.length = 0;
  });

  it("tells the user to download a file that is too large to preview", async () => {
    const { result } = renderHook(() => useArtifactActions({ onError: vi.fn() }));

    await act(async () => {
      void result.current.openPreview(makeArtifact("a-1"));
    });
    await act(async () => {
      loaderState.pending[0]!.reject(new ArtifactPreviewTooLargeError());
    });

    expect(result.current.previewError).toBe(TEXT_PREVIEW_TOO_LARGE_MESSAGE);
    expect(result.current.previewContent).toBeNull();
    expect(result.current.isLoadingPreview).toBe(false);
  });

  it("keeps the generic message for other failures", async () => {
    const { result } = renderHook(() => useArtifactActions({ onError: vi.fn() }));

    await act(async () => {
      void result.current.openPreview(makeArtifact("a-1"));
    });
    await act(async () => {
      loaderState.pending[0]!.reject(new Error("network"));
    });

    expect(result.current.previewError).toBe(
      "Failed to load preview. Try downloading the file instead."
    );
  });
});
