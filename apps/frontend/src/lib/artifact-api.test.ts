import { describe, it, vi, expect } from "vitest";

import { fetchArtifactContent, fetchArtifactPreviewText } from "./artifact-api";

describe("fetchArtifactContent", () => {
  it("returns text content for a text artifact", async () => {
    const fakeText = "hello world";
    const fakeFetch = vi.fn(async () => ({
      ok: true,
      text: async () => fakeText,
    }));
    // @ts-expect-error — stub
    global.fetch = fakeFetch;

    const content = await fetchArtifactContent("http://localhost/downloads/tok123");
    expect(content).toBe(fakeText);
  });

  it("throws when the response is not ok", async () => {
    const fakeFetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => "not found",
    }));
    // @ts-expect-error — stub
    global.fetch = fakeFetch;

    const err = await fetchArtifactContent("http://localhost/downloads/tok_bad").catch(
      (e: unknown) => e
    );
    expect(err instanceof Error).toBeTruthy();
    expect((err as Error).message.includes("404")).toBeTruthy();
  });
});

describe("fetchArtifactPreviewText", () => {
  it("returns the parsed text and requests the preview-text endpoint", async () => {
    const calls: string[] = [];
    const fakeFetch = vi.fn(async (url: string) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        // request() reads response.json() (not text()) for preview-text.
        json: async () => ({ text: "preview body" })
      };
    });
    // @ts-expect-error — stub
    global.fetch = fakeFetch;

    const text = await fetchArtifactPreviewText("art-1");

    expect(text).toBe("preview body");
    expect(calls).toHaveLength(1);
    expect(calls[0].endsWith("/artifacts/art-1/preview-text")).toBe(true);
  });

  it("rejects with a schema-mismatch error when the payload shape is wrong", async () => {
    const fakeFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      // Missing the required `text` field → schema validation must reject.
      json: async () => ({ wrong: 1 })
    }));
    // @ts-expect-error — stub
    global.fetch = fakeFetch;

    const err = await fetchArtifactPreviewText("art-1").catch((e: unknown) => e);

    expect(err instanceof Error).toBe(true);
    expect((err as Error).message).toContain("Schema mismatch");
  });
});
