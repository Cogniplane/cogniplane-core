import { afterEach, expect, test } from "vitest";

import { GET } from "./route";

afterEach(() => { delete process.env.MCP_APP_PARENT_ORIGIN; });

test("serves the sandbox with a configured parent and no inherited script limit", async () => {
  process.env.MCP_APP_PARENT_ORIGIN = "https://chat.example.test";
  const response = GET();
  expect(response.headers.get("content-security-policy"))
    .toBe("frame-ancestors https://chat.example.test; object-src 'none'");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-security-policy")).not.toContain("script-src");
  const html = await response.text();
  expect(html).toContain("ui/notifications/sandbox-proxy-ready");
  // The page talks to the same origin that the framing policy allows.
  expect(html).toContain('const parentOrigin = "https://chat.example.test";');
});

test("denies framing when the parent origin is missing, and the page has no parent to talk to", async () => {
  const response = GET();
  expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'none'; object-src 'none'");
  expect(await response.text()).toContain("const parentOrigin = null;");
});
