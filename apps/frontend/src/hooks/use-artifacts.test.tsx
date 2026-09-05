// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Artifact } from "@cogniplane/shared-types";

import { useArtifacts } from "./use-artifacts";

afterEach(cleanup);

function artifact(id: string, overrides: Partial<Artifact> = {}): Artifact {
  return {
    artifactId: id,
    artifactName: id,
    artifactType: "upload",
    sessionId: "s-1",
    userId: "u-1",
    status: "ready",
    mimeType: "text/plain",
    sourceArtifactId: null,
    fileSizeBytes: 10,
    storageBackend: "local",
    storageKey: id,
    checksumSha256: "test-checksum",
    createdByType: "user",
    createdByRef: null,
    detail: {},
    createdAt: "2026-09-04T12:00:00Z",
    updatedAt: "2026-09-04T12:00:00Z",
    ...overrides
  };
}

function renderSelection(artifacts: Artifact[]) {
  const onError = vi.fn();
  const onRefresh = vi.fn(async () => undefined);
  return renderHook(
    (props: { selectedSessionId: string | null; artifacts: Artifact[] }) =>
      useArtifacts({ ...props, onError, onRefresh }),
    { initialProps: { selectedSessionId: "s-1" as string | null, artifacts } }
  );
}

describe("chat artifact selection", () => {
  it("follows the newest upload automatically until the user changes the selection", () => {
    const old = artifact("old");
    const newer = artifact("newer", { updatedAt: "2026-09-04T13:00:00Z" });
    const { result, rerender } = renderSelection([old]);
    expect(result.current.visibleSelectedArtifactIds).toEqual(["old"]);

    rerender({ selectedSessionId: "s-1", artifacts: [old, newer] });
    expect(result.current.visibleSelectedArtifactIds).toEqual(["newer"]);
    act(() => result.current.toggleArtifactSelection("newer"));
    expect(result.current.visibleSelectedArtifactIds).toEqual([]);

    rerender({ selectedSessionId: "s-1", artifacts: [old, newer, artifact("newest")] });
    expect(result.current.visibleSelectedArtifactIds).toEqual([]);
    act(() => result.current.toggleArtifactSelection("old"));
    expect(result.current.visibleSelectedArtifactIds).toEqual(["old"]);
  });

  it("resets manual choices when switching sessions and when revisiting one", () => {
    const a = artifact("a");
    const b = artifact("b", { sessionId: "s-2" });
    const { result, rerender } = renderSelection([a]);
    act(() => result.current.toggleArtifactSelection("a"));
    expect(result.current.visibleSelectedArtifactIds).toEqual([]);

    rerender({ selectedSessionId: "s-2", artifacts: [b] });
    expect(result.current.visibleSelectedArtifactIds).toEqual(["b"]);
    rerender({ selectedSessionId: "s-1", artifacts: [a] });
    expect(result.current.visibleSelectedArtifactIds).toEqual(["a"]);
    rerender({ selectedSessionId: null, artifacts: [] });
    expect(result.current.visibleSelectedArtifactIds).toEqual([]);
  });

  it("excludes a selected artifact as soon as it becomes ineligible", () => {
    const a = artifact("a");
    const b = artifact("b");
    const { result, rerender } = renderSelection([a, b]);
    act(() => result.current.selectArtifact("b"));
    expect(result.current.visibleSelectedArtifactIds).toEqual(["a", "b"]);

    rerender({ selectedSessionId: "s-1", artifacts: [a, { ...b, status: "processing" }] });
    expect(result.current.visibleSelectedArtifactIds).toEqual(["a"]);
    rerender({ selectedSessionId: "s-1", artifacts: [a, { ...b, detail: { pii: { status: "blocked" } } }] });
    expect(result.current.visibleSelectedArtifactIds).toEqual(["a"]);
    rerender({ selectedSessionId: "s-1", artifacts: [a, b] });
    expect(result.current.visibleSelectedArtifactIds).toEqual(["a", "b"]);
  });

  it("forgets removed manual selections instead of restoring them if the row returns", () => {
    const a = artifact("a");
    const b = artifact("b");
    const { result, rerender } = renderSelection([a, b]);
    act(() => result.current.selectArtifact("b"));
    rerender({ selectedSessionId: "s-1", artifacts: [a] });
    expect(result.current.visibleSelectedArtifactIds).toEqual(["a"]);
    rerender({ selectedSessionId: "s-1", artifacts: [a, b] });
    expect(result.current.visibleSelectedArtifactIds).toEqual(["a"]);
  });

  it("retains an imported selection until the refreshed artifact inventory arrives", () => {
    const a = artifact("a");
    const b = artifact("b");
    const { result, rerender } = renderSelection([a]);
    act(() => result.current.selectArtifact("b"));
    expect(result.current.visibleSelectedArtifactIds).toEqual(["a"]);
    rerender({ selectedSessionId: "s-1", artifacts: [a, b] });
    expect(result.current.visibleSelectedArtifactIds).toEqual(["a", "b"]);
  });
});
