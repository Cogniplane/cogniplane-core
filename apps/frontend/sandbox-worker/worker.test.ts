import assert from "node:assert/strict";
import { test } from "node:test";

import worker from "./worker.ts";

const env: Env = { MCP_APP_PARENT_ORIGIN: "http://localhost:3000" };

test("the sandbox Worker serves only the isolated app bridge", async () => {
  const response = worker.fetch(new Request("https://sandbox.example.com/mcp-app-sandbox.html"), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-security-policy"),
    "frame-ancestors http://localhost:3000; object-src 'none'");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const html = await response.text();
  assert.match(html, /ui\/notifications\/sandbox-proxy-ready/);
  assert.match(html, /const parentOrigin = "http:\/\/localhost:3000";/);

  const head = worker.fetch(new Request("https://sandbox.example.com/mcp-app-sandbox.html", { method: "HEAD" }), env);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-security-policy"),
    "frame-ancestors http://localhost:3000; object-src 'none'");
  assert.equal(await head.text(), "");

  const otherPath = worker.fetch(new Request("https://sandbox.example.com/"), env);
  assert.equal(otherPath.status, 404);
  const post = worker.fetch(new Request("https://sandbox.example.com/mcp-app-sandbox.html", { method: "POST" }), env);
  assert.equal(post.status, 405);
});

test("the sandbox Worker page has no parent to talk to when the parent origin is not valid", async () => {
  const response = worker.fetch(
    new Request("https://sandbox.example.com/mcp-app-sandbox.html"),
    { MCP_APP_PARENT_ORIGIN: "http://localhost:3000/app" } as unknown as Env
  );
  assert.equal(response.headers.get("content-security-policy"), "frame-ancestors 'none'; object-src 'none'");
  assert.match(await response.text(), /const parentOrigin = null;/);
});
