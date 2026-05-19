import { test, expect } from "vitest";
import { isForbidden, FORBIDDEN_LICENSES } from "./license-check.ts";

test("isForbidden: simple permissive licenses are allowed", () => {
  expect(isForbidden("MIT")).toBe(null);
  expect(isForbidden("Apache-2.0")).toBe(null);
  expect(isForbidden("BSD-2-Clause")).toBe(null);
  expect(isForbidden("ISC")).toBe(null);
});

test("isForbidden: bare GPL/AGPL/SSPL/BUSL forbidden", () => {
  expect(isForbidden("GPL-3.0")).toBe("GPL-3.0");
  expect(isForbidden("GPL-3.0-or-later")).toBe("GPL-3.0-or-later");
  expect(isForbidden("AGPL-3.0")).toBe("AGPL-3.0");
  expect(isForbidden("SSPL-1.0")).toBe("SSPL-1.0");
  expect(isForbidden("BUSL-1.1")).toBe("BUSL-1.1");
  expect(isForbidden("Elastic-2.0")).toBe("Elastic-2.0");
});

test("isForbidden: dual-licensed OR — allowed branch wins (jszip case)", () => {
  // The consumer picks: choosing MIT keeps us compliant.
  expect(isForbidden("(MIT OR GPL-3.0-or-later)")).toBe(null);
  expect(isForbidden("MIT OR Apache-2.0")).toBe(null);
  expect(isForbidden("(Apache-2.0 OR GPL-2.0)")).toBe(null);
});

test("isForbidden: OR with all branches forbidden — still forbidden", () => {
  // No acceptable branch to pick, so the dep cannot ship.
  expect(isForbidden("GPL-2.0 OR GPL-3.0")).toBe("GPL-2.0");
  expect(isForbidden("(AGPL-3.0 OR GPL-3.0-or-later)")).toBe("AGPL-3.0");
});

test("isForbidden: AND with any forbidden token — forbidden", () => {
  // Consumer must comply with both terms; the GPL term taints the whole.
  expect(isForbidden("MIT AND GPL-3.0")).toBe("GPL-3.0");
  expect(isForbidden("(Apache-2.0 AND AGPL-3.0)")).toBe("AGPL-3.0");
});

test("isForbidden: parenthesized whole expressions parsed correctly", () => {
  expect(isForbidden("(MIT)")).toBe(null);
  expect(isForbidden("(GPL-3.0)")).toBe("GPL-3.0");
});

test("isForbidden: all canonical GPL/AGPL variants are in FORBIDDEN_LICENSES", () => {
  // Catches the case where someone removes a variant from the set: regression
  // guard for the strict-id list.
  for (const id of [
    "GPL-2.0",
    "GPL-2.0-only",
    "GPL-2.0-or-later",
    "GPL-3.0",
    "GPL-3.0-only",
    "GPL-3.0-or-later",
    "AGPL-3.0",
    "AGPL-3.0-only",
    "AGPL-3.0-or-later"
  ]) {
    expect(FORBIDDEN_LICENSES.has(id)).toBe(true);
  }
});

test("isForbidden: LGPL is NOT forbidden (different obligations)", () => {
  // LGPL-2.1 / LGPL-3.0 only require source disclosure for the LGPL'd lib
  // itself, not the linking application. They're compatible with our
  // dual-license model and aren't in the forbidden list. This guards
  // against an accidental over-broad addition like "GPL".
  expect(isForbidden("LGPL-2.1")).toBe(null);
  expect(isForbidden("LGPL-3.0")).toBe(null);
});
