import { afterEach, describe, expect, test, vi } from "vitest";

import { buildOpenRouterCatalogFetcher } from "./openrouter-catalog.js";

afterEach(() => { vi.restoreAllMocks(); });

function respond(body: unknown, status = 200) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

describe("buildOpenRouterCatalogFetcher", () => {
  test("keeps entries with a slug, falls back to the slug as name, and keeps only a positive context length", async () => {
    const fetchImpl = respond({
      data: [
        { id: "moonshotai/kimi", name: "Kimi", context_length: 200_000.7 },
        { id: "openai/gpt", name: "", context_length: 0 },
        { id: "x/no-context", context_length: "big" },
        { id: "", name: "Empty slug" },
        { id: 42, name: "Numeric slug" },
        { name: "No slug" }
      ]
    });

    const entries = await buildOpenRouterCatalogFetcher({ fetchImpl })();

    expect(entries).toEqual([
      { id: "moonshotai/kimi", name: "Kimi", contextLength: 200_000 },
      { id: "openai/gpt", name: "openai/gpt", contextLength: null },
      { id: "x/no-context", name: "x/no-context", contextLength: null }
    ]);
    // The URL is fixed, so a caller cannot point the server anywhere else.
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://openrouter.ai/api/v1/models");
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ headers: { Accept: "application/json" } });
  });

  test.each([
    ["a failed response", respond({}, 503), "OpenRouter models API responded 503"],
    ["no usable entry", respond({ data: [{ id: "" }] }), "OpenRouter models API returned an empty catalog"],
    ["no data at all", respond({}), "OpenRouter models API returned an empty catalog"]
  ])("rejects %s", async (_case, fetchImpl, message) => {
    await expect(buildOpenRouterCatalogFetcher({ fetchImpl })()).rejects.toThrow(message);
  });

  test("serves the cached catalog until the TTL ends, then reloads it", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetchImpl = respond({ data: [{ id: "a/model" }] });
    const fetchCatalog = buildOpenRouterCatalogFetcher({ fetchImpl, ttlMs: 60_000 });

    await fetchCatalog();
    now += 59_999;
    await fetchCatalog();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += 1;
    await fetchCatalog();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("makes one upstream request for concurrent misses", async () => {
    const fetchImpl = respond({ data: [{ id: "a/model" }] });
    const fetchCatalog = buildOpenRouterCatalogFetcher({ fetchImpl });

    const [first, second] = await Promise.all([fetchCatalog(), fetchCatalog()]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  test("does not cache a failure", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "a/model" }] }), { status: 200 }));
    const fetchCatalog = buildOpenRouterCatalogFetcher({ fetchImpl });

    await expect(fetchCatalog()).rejects.toThrow("responded 502");
    expect(await fetchCatalog()).toEqual([{ id: "a/model", name: "a/model", contextLength: null }]);
  });
});
