import { test, expect } from "vitest";

import { createFakeFetch, normalizeFetchUrl, withStubbedFetch } from "./fake-fetch.js";

test("normalizeFetchUrl handles string, URL, and Request inputs", () => {
  expect(normalizeFetchUrl("https://example.com/a")).toBe("https://example.com/a");
  expect(normalizeFetchUrl(new URL("https://example.com/b"))).toBe("https://example.com/b");
  expect(normalizeFetchUrl(new Request("https://example.com/c"))).toBe("https://example.com/c");
});

test("createFakeFetch installs the stub, records calls, and restores the original", async () => {
  const original = globalThis.fetch;
  const fake = createFakeFetch((url) => new Response(`hit:${url}`, { status: 200 }));

  expect(globalThis.fetch).toBe(fake.fetchImpl);

  const res = await fetch("https://example.com/x", { method: "POST" });
  expect(await res.text()).toBe("hit:https://example.com/x");
  expect(fake.calls).toEqual([{ url: "https://example.com/x", init: { method: "POST" } }]);

  fake.restore();
  expect(globalThis.fetch).toBe(original);
});

test("createFakeFetch records an empty init object when none is passed", async () => {
  const fake = createFakeFetch(() => new Response("{}", { status: 200 }));
  try {
    await fetch("https://example.com/no-init");
    expect(fake.calls[0]).toEqual({ url: "https://example.com/no-init", init: {} });
  } finally {
    fake.restore();
  }
});

test("withStubbedFetch restores the original even when the body throws", async () => {
  const original = globalThis.fetch;
  await expect(
    withStubbedFetch(
      () => new Response("ok"),
      async () => {
        throw new Error("boom");
      }
    )
  ).rejects.toThrow("boom");
  expect(globalThis.fetch).toBe(original);
});

test("withStubbedFetch returns the body result and exposes captured calls", async () => {
  const value = await withStubbedFetch(
    (url) => new Response(JSON.stringify({ url }), { status: 200 }),
    async (fake) => {
      const res = await fetch("https://example.com/y");
      const body = (await res.json()) as { url: string };
      expect(fake.calls).toHaveLength(1);
      return body.url;
    }
  );
  expect(value).toBe("https://example.com/y");
});
