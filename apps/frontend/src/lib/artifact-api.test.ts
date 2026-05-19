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
  it("is exported and accepts an artifactId string", () => {
    expect(typeof fetchArtifactPreviewText).toBe("function");
    // returns a Promise when called (even if it rejects without a server)
    const result = fetchArtifactPreviewText("some-id");
    expect(result instanceof Promise).toBeTruthy();
    result.catch(() => {}); // suppress unhandled rejection
  });
});
