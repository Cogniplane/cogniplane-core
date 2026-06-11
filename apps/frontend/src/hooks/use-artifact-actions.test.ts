// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Artifact } from "@cogniplane/shared-types";

import { useArtifactActions } from "./use-artifact-actions";

// vitest runs with globals:false, so RTL cannot auto-register its cleanup.
afterEach(cleanup);

const loaderState = vi.hoisted(() => ({
  pending: [] as Array<{
    artifactId: string;
    resolve: (result: { kind: "text"; text: string }) => void;
  }>
}));

vi.mock("../lib/artifact-preview-loader", () => ({
  artifactApiBase: () => "http://test",
  loadArtifactPreview: vi.fn(
    (artifact: { artifactId: string }) =>
      new Promise((resolve) => {
        loaderState.pending.push({ artifactId: artifact.artifactId, resolve });
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
