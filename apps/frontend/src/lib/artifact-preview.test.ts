import { describe, it, expect } from "vitest";
import { canPreviewArtifact, getPreviewLanguage, isImageArtifact, isPdfArtifact } from "./artifact-preview";

describe("canPreviewArtifact", () => {
  it("returns true for text/plain", () =>
    expect(canPreviewArtifact({ mimeType: "text/plain", status: "ready" })).toBe(true));

  it("returns true for application/json", () =>
    expect(canPreviewArtifact({ mimeType: "application/json", status: "ready" })).toBe(true));

  it("returns false for deleted artifacts", () =>
    expect(canPreviewArtifact({ mimeType: "text/plain", status: "deleted" })).toBe(false));

  it("returns false for pending artifacts", () =>
    expect(canPreviewArtifact({ mimeType: "text/plain", status: "pending" })).toBe(false));

  it("returns false for processing artifacts", () =>
    expect(canPreviewArtifact({ mimeType: "text/plain", status: "processing" })).toBe(false));

  it("returns false for failed artifacts", () =>
    expect(canPreviewArtifact({ mimeType: "text/plain", status: "failed" })).toBe(false));

  it("returns false for unsupported MIME type", () =>
    expect(canPreviewArtifact({ mimeType: "application/octet-stream", status: "ready" })).toBe(false));

  it("returns true for image/png", () =>
    expect(canPreviewArtifact({ mimeType: "image/png", status: "ready" })).toBe(true));
  it("returns true for image/jpeg", () =>
    expect(canPreviewArtifact({ mimeType: "image/jpeg", status: "ready" })).toBe(true));
  it("returns true for application/pdf", () =>
    expect(canPreviewArtifact({ mimeType: "application/pdf", status: "ready" })).toBe(true));
});

describe("isImageArtifact", () => {
  it("returns true for image/png", () =>
    expect(isImageArtifact("image/png")).toBe(true));
  it("returns true for image/jpeg", () =>
    expect(isImageArtifact("image/jpeg")).toBe(true));
  it("returns true for image/gif", () =>
    expect(isImageArtifact("image/gif")).toBe(true));
  it("returns true for image/webp", () =>
    expect(isImageArtifact("image/webp")).toBe(true));
  it("returns false for text/plain", () =>
    expect(isImageArtifact("text/plain")).toBe(false));
  it("returns false for application/pdf", () =>
    expect(isImageArtifact("application/pdf")).toBe(false));
});

describe("isPdfArtifact", () => {
  it("returns true for application/pdf", () =>
    expect(isPdfArtifact("application/pdf")).toBe(true));
  it("returns false for image/png", () =>
    expect(isPdfArtifact("image/png")).toBe(false));
  it("returns false for text/plain", () =>
    expect(isPdfArtifact("text/plain")).toBe(false));
});

describe("getPreviewLanguage", () => {
  it("maps text/x-python to python", () =>
    expect(getPreviewLanguage("text/x-python")).toBe("python"));

  it("maps application/json to json", () =>
    expect(getPreviewLanguage("application/json")).toBe("json"));

  it("maps text/markdown to markdown", () =>
    expect(getPreviewLanguage("text/markdown")).toBe("markdown"));

  it("maps unknown to plaintext", () =>
    expect(getPreviewLanguage("application/octet-stream")).toBe("plaintext"));
});
