import { hkdfSync } from "node:crypto";

import { expect, test } from "vitest";

import {
  DERIVED_SECRET_LABELS,
  deriveSecret,
  proxySignatureSecret,
  runtimeTokenSecret
} from "./derived-secrets.js";

const ROOT = "root-secret-that-is-at-least-32-characters-long";

test("a derived key is never the root secret", () => {
  expect(runtimeTokenSecret(ROOT)).not.toBe(ROOT);
  expect(proxySignatureSecret(ROOT)).not.toBe(ROOT);
});

test("the two purposes derive different keys", () => {
  // The whole point of R13: a partner holding the upstream-signature key must
  // not be able to mint rt_* gateway tokens.
  expect(runtimeTokenSecret(ROOT)).not.toBe(proxySignatureSecret(ROOT));
});

test("derivation is deterministic, so a token minted in one process verifies in another", () => {
  expect(runtimeTokenSecret(ROOT)).toBe(runtimeTokenSecret(ROOT));
  expect(proxySignatureSecret(ROOT)).toBe(proxySignatureSecret(ROOT));
});

test("a different root produces a different key for the same label", () => {
  const other = "a-completely-different-root-secret-32-chars";
  expect(runtimeTokenSecret(ROOT)).not.toBe(runtimeTokenSecret(other));
});

test("the label is what separates the domains", () => {
  expect(deriveSecret(ROOT, DERIVED_SECRET_LABELS.runtimeToken)).toBe(runtimeTokenSecret(ROOT));
  expect(deriveSecret(ROOT, DERIVED_SECRET_LABELS.proxySignature)).toBe(
    proxySignatureSecret(ROOT)
  );
});

test("MCP_UPSTREAM_SIGNING_SECRET overrides the derived signature key", () => {
  const override = "operator-supplied-upstream-signing-secret-value";
  expect(proxySignatureSecret(ROOT, override)).toBe(override);
});

test("a blank or whitespace override falls back to the derived key", () => {
  // An unset env var arrives as "" through some deploy paths; treating that as
  // a real secret would sign every upstream call with the empty string.
  expect(proxySignatureSecret(ROOT, "")).toBe(proxySignatureSecret(ROOT));
  expect(proxySignatureSecret(ROOT, "   ")).toBe(proxySignatureSecret(ROOT));
  expect(proxySignatureSecret(ROOT, undefined)).toBe(proxySignatureSecret(ROOT));
});

test("a derived key decodes to a full 32 bytes", () => {
  // Length alone would also pass for a padded or truncated value; decode it.
  for (const key of [runtimeTokenSecret(ROOT), proxySignatureSecret(ROOT)]) {
    expect(Buffer.from(key, "base64url")).toHaveLength(32);
  }
});

test("derivation matches HKDF-SHA256 under the documented label", () => {
  // Pins the construction itself, not just that two calls agree with each
  // other. A change to the salt, the hash, or the label ordering is a rotation
  // that silently invalidates every rt_* token in flight, so it must be a
  // deliberate edit to this expectation rather than a quiet drift.
  const expected = Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(ROOT, "utf8"),
      Buffer.from("cogniplane-derived-secrets-v1"),
      Buffer.from(DERIVED_SECRET_LABELS.runtimeToken, "utf8"),
      32
    )
  ).toString("base64url");

  expect(runtimeTokenSecret(ROOT)).toBe(expected);
});
