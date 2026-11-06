// @vitest-environment jsdom
import type { Artifact } from "@cogniplane/shared-types";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ArtifactCardProvider, GenerativeArtifactCard, type ArtifactCardInventory } from "./artifact-card";
import { useArtifactActions } from "../hooks/use-artifact-actions";
import { ArtifactPreviewModal } from "./artifact-preview-modal";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ID = "8f14e45f-ea2c-4f6b-9a3d-8a2e1c7d0b11";

function artifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    artifactId: ID,
    sessionId: "s-1",
    artifactName: "Quarterly report.csv",
    mimeType: "text/csv",
    fileSizeBytes: 2048,
    status: "ready",
    storageKey: "tenant/secret/key.csv",
    detail: { pii: { status: "scanned", findingsCount: 2 } },
    ...overrides
  } as Artifact;
}

function cardIn(sessionId: string, inventory: ArtifactCardInventory | undefined) {
  return (
    <ArtifactCardProvider sessionId={sessionId} inventory={inventory}>
      <GenerativeArtifactCard artifactId={ID} />
    </ArtifactCardProvider>
  );
}

const preview = () => screen.queryByRole("button", { name: "Preview" });

describe("GenerativeArtifactCard", () => {
  it("shows the stored metadata and opens the preview only on a click", () => {
    const onOpenPreview = vi.fn();
    render(cardIn("s-1", { artifacts: [artifact()], onOpenPreview }));

    const card = screen.getByRole("article", { name: "Quarterly report.csv" });
    expect(card.textContent).toContain("Ready · 2.0 KB · text/csv");
    expect(card.textContent).toContain("PII: 2 findings");
    expect(card.textContent).not.toContain("tenant/secret");
    expect(onOpenPreview).not.toHaveBeenCalled();

    fireEvent.click(preview()!);

    expect(onOpenPreview).toHaveBeenCalledExactlyOnceWith(ID);
  });

  it("does not show or open an artifact of another session, also when the list mixes sessions", () => {
    const onOpenPreview = vi.fn();
    render(cardIn("s-1", { artifacts: [artifact({ sessionId: "s-2" })], onOpenPreview }));

    expect(screen.getByRole("note").textContent).toBe("This file is not available in this chat.");
    expect(screen.queryByText("Quarterly report.csv")).toBeNull();
    expect(preview()).toBeNull();
  });

  it("shows no file without a provider or a preview action", () => {
    render(<GenerativeArtifactCard artifactId={ID} />);
    expect(screen.getByRole("note")).toBeTruthy();
    cleanup();
    render(cardIn("s-1", undefined));
    expect(screen.getByRole("note")).toBeTruthy();
    expect(preview()).toBeNull();
  });

  it.each([
    ["pending", { status: "pending" }],
    ["processing", { status: "processing" }],
    ["failed", { status: "failed" }],
    ["deleted", { status: "deleted" }],
    ["PII-blocked", { detail: { pii: { status: "blocked", blockReason: "SSN found" } } }],
    ["still scanning", { detail: { pii: { status: "scanning" } } }],
    ["unsupported", { mimeType: "application/zip" }]
  ] as const)("shows a %s file without a Preview button", (_, overrides) => {
    render(cardIn("s-1", { artifacts: [artifact(overrides as Partial<Artifact>)], onOpenPreview: vi.fn() }));

    expect(screen.getByRole("article", { name: "Quarterly report.csv" })).toBeTruthy();
    expect(preview()).toBeNull();
  });

  it("follows a refresh of the list: a pending file becomes ready and can open", () => {
    const onOpenPreview = vi.fn();
    const view = render(cardIn("s-1", { artifacts: [artifact({ status: "pending" })], onOpenPreview }));
    expect(screen.getByText("Preview is available when the file is ready.")).toBeTruthy();
    expect(preview()).toBeNull();

    view.rerender(cardIn("s-1", { artifacts: [artifact()], onOpenPreview }));

    fireEvent.click(preview()!);
    expect(onOpenPreview).toHaveBeenCalledExactlyOnceWith(ID);

    view.rerender(cardIn("s-1", { artifacts: [artifact({ status: "deleted" })], onOpenPreview }));
    expect(preview()).toBeNull();
  });
});

function PreviewFlow() {
  const artifacts = [artifact({ mimeType: "text/markdown", artifactName: "Report.md" })];
  const actions = useArtifactActions({ artifacts, onError: () => undefined });
  return <>
    <ArtifactCardProvider sessionId="s-1" inventory={{ artifacts, onOpenPreview: (id) => void actions.openPreview(id) }}>
      <GenerativeArtifactCard artifactId={ID} />
    </ArtifactCardProvider>
    {actions.previewArtifactId ? <ArtifactPreviewModal
      artifactName={actions.previewName} mimeType={actions.previewMimeType}
      content={actions.previewContent} imageUrl={actions.previewImageUrl}
      error={actions.previewError} onClose={actions.closePreview}
    /> : null}
  </>;
}

describe("ArtifactCard through the existing preview flow", () => {
  it.each([false, true])("opens the real preview modal and handles API refusal: %s", async (refused) => {
    const fetch = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === `/artifacts/${ID}/download-token`) {
        return Response.json(refused ? { error: "forbidden", message: "Forbidden" } : {
          download: { token: "fixture-token", url: "/downloads/fixture-token", expiresAt: "2026-10-31T12:00:00.000Z" }
        }, { status: refused ? 403 : 200 });
      }
      return new Response("## Stored preview\n\nReady to review.");
    });
    vi.stubGlobal("fetch", fetch);
    render(<PreviewFlow />);
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(preview()!);

    const dialog = await screen.findByRole("dialog", { name: "Report.md" });
    if (refused) {
      expect(await screen.findByText("Failed to load preview. Try downloading the file instead.")).toBeTruthy();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(dialog.textContent).not.toContain("Stored preview");
    } else {
      expect(await screen.findByRole("heading", { name: "Stored preview" })).toBeTruthy();
      expect(dialog.textContent).toContain("Ready to review.");
      expect(fetch).toHaveBeenCalledTimes(2);
    }
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      `/artifacts/${ID}/download-token`, ...refused ? [] : ["/downloads/fixture-token"]
    ]);
    expect(fetch.mock.calls[0]![1]?.method).toBe("POST");
    expect(fetch.mock.calls.every(([, init]) => init?.credentials === "include")).toBe(true);
  });
});
