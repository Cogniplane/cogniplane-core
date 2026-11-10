import { afterEach, describe, it, vi, expect } from "vitest";

import { fetchArtifactContent, fetchArtifactPreviewText } from "./artifact-api";
import { ArtifactPreviewTooLargeError } from "./artifact-preview";

const DOWNLOAD_URL = "http://localhost/downloads/tok123";
const encode = (text: string) => new TextEncoder().encode(text);

// A body that records how many chunks the reader pulled and whether it
// cancelled the download.
function streamedResponse(chunks: Uint8Array[], init: ResponseInit = {}) {
  let pulled = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled === chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[pulled++]!);
    },
    cancel() {
      cancelled = true;
    }
  });
  return {
    response: new Response(body, init),
    pulled: () => pulled,
    cancelled: () => cancelled
  };
}

function serve(response: Response) {
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("fetchArtifactContent", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns text content for a text artifact", async () => {
    const fetchMock = serve(new Response("hello world"));

    await expect(fetchArtifactContent(DOWNLOAD_URL, 64)).resolves.toBe("hello world");
    expect(fetchMock).toHaveBeenCalledWith(DOWNLOAD_URL, expect.objectContaining({ cache: "no-store" }));
  });

  it("accepts a body of exactly the limit", async () => {
    serve(new Response("12345678"));

    await expect(fetchArtifactContent(DOWNLOAD_URL, 8)).resolves.toBe("12345678");
  });

  it("decodes a UTF-8 character that is split across two chunks", async () => {
    const bytes = encode("café");
    serve(streamedResponse([bytes.slice(0, 4), bytes.slice(4)]).response);

    await expect(fetchArtifactContent(DOWNLOAD_URL, 64)).resolves.toBe("café");
  });

  it("throws when the response is not ok", async () => {
    serve(new Response("not found", { status: 404 }));

    const err = await fetchArtifactContent("http://localhost/downloads/tok_bad", 64).catch(
      (e: unknown) => e
    );
    expect(err instanceof Error).toBeTruthy();
    expect((err as Error).message.includes("404")).toBeTruthy();
  });

  it("rejects a Content-Length over the limit before it reads the body", async () => {
    const body = streamedResponse(Array.from({ length: 4 }, () => encode("abcd")), {
      headers: { "content-length": "16" }
    });
    serve(body.response);

    await expect(fetchArtifactContent(DOWNLOAD_URL, 8)).rejects.toBeInstanceOf(
      ArtifactPreviewTooLargeError
    );
    expect(body.cancelled()).toBe(true);
    // The stream queues one chunk when it is made. The read loop would pull 3.
    expect(body.pulled()).toBeLessThanOrEqual(1);
  });

  it("stops reading when a body with no Content-Length passes the limit", async () => {
    const body = streamedResponse(Array.from({ length: 10 }, () => encode("abcd")));
    serve(body.response);

    await expect(fetchArtifactContent(DOWNLOAD_URL, 8)).rejects.toBeInstanceOf(
      ArtifactPreviewTooLargeError
    );
    expect(body.cancelled()).toBe(true);
    expect(body.pulled()).toBeLessThan(10);
  });

  it("counts the bytes read when Content-Length is smaller than the body", async () => {
    const body = streamedResponse(Array.from({ length: 10 }, () => encode("abcd")), {
      headers: { "content-length": "4" }
    });
    serve(body.response);

    await expect(fetchArtifactContent(DOWNLOAD_URL, 8)).rejects.toBeInstanceOf(
      ArtifactPreviewTooLargeError
    );
    expect(body.cancelled()).toBe(true);
    expect(body.pulled()).toBeLessThan(10);
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
