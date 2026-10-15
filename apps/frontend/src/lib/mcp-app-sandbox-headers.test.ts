import { expect, it } from "vitest";

import { mcpAppParentOrigin, sandboxSecurityHeaders } from "./mcp-app-sandbox-headers";

it.each([
  ["https://chat.example.test", "https://chat.example.test"],
  ["https://CHAT.example.test:443", "https://chat.example.test"],
  ["https://chat.example.test:8443/", "https://chat.example.test:8443"],
  ["http://localhost:3000", "http://localhost:3000"],
  ["http://127.0.0.1:3000", "http://127.0.0.1:3000"]
])("accepts %s as the parent origin and returns %s", (raw, origin) => {
  expect(mcpAppParentOrigin(raw)).toBe(origin);
});

it.each([
  ["no setting", undefined],
  ["an empty setting", ""],
  ["plain http on a public host", "http://chat.example.test"],
  ["a value with a path", "https://chat.example.test/app"],
  ["a value with a query", "https://chat.example.test/?x=1"],
  ["a value with a fragment", "https://chat.example.test/#x"],
  ["a value with credentials", "https://user:secret@chat.example.test"],
  ["a script scheme", "javascript:alert(1)"],
  ["text that is not a URL", "chat.example.test"]
])("rejects %s as the parent origin", (_name, raw) => {
  expect(mcpAppParentOrigin(raw)).toBeNull();
});

it("builds the framing policy from the same parent origin", () => {
  expect(sandboxSecurityHeaders("https://chat.example.test:443/").get("content-security-policy"))
    .toBe("frame-ancestors https://chat.example.test; object-src 'none'");
  expect(sandboxSecurityHeaders("https://chat.example.test/app").get("content-security-policy"))
    .toBe("frame-ancestors 'none'; object-src 'none'");
});
