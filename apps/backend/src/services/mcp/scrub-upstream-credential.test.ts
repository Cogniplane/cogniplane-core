import { expect, test } from "vitest";
import { scrubUpstreamCredential } from "./scrub-upstream-credential.js";

test("scrubs raw and URL-encoded upstream credentials from values and keys", () => {
  const secret = "Ab c+/x%9";
  const uri = encodeURIComponent(secret);
  const form = new URLSearchParams([["credential", secret]]).toString().slice("credential=".length);
  const lowerEscapes = uri.replace(/%[0-9A-F]{2}/g, (part) => part.toLowerCase());
  const result = scrubUpstreamCredential({
    [uri]: `raw=${secret}&uri=${uri}&form=${form}&lower=${lowerEscapes}`,
    nested: [{ url: `https://example.test/?credential=${form}` }]
  }, secret);
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.stringify(result)).not.toContain(uri);
  expect(JSON.stringify(result)).not.toContain(form);
  expect(JSON.stringify(result)).not.toContain(lowerEscapes);
  expect(result).toEqual({
    "[REDACTED]": "raw=[REDACTED]&uri=[REDACTED]&form=[REDACTED]&lower=[REDACTED]",
    nested: [{ url: "https://example.test/?credential=[REDACTED]" }]
  });
});

test("scrubs a malformed Unicode credential without failing the response", () => {
  const secret = "secret-\uD800";
  const result = scrubUpstreamCredential({ raw: secret, url: `?key=${encodeURIComponent("secret-\uFFFD")}` }, secret);
  expect(result).toEqual({ raw: "[REDACTED]", url: "?key=[REDACTED]" });
});
