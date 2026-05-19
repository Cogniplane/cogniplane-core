import { describe, expect, test } from "vitest";

import { cidrAllowlistAllows, parseCidrAllowlist } from "./cidr-allowlist.js";

describe("parseCidrAllowlist", () => {
  test("returns null for empty / whitespace-only input", () => {
    expect(parseCidrAllowlist("")).toBeNull();
    expect(parseCidrAllowlist("   ,  , ")).toBeNull();
  });

  test("accepts bare IPv4 (treated as /32) and IPv4 subnets", () => {
    const list = parseCidrAllowlist("203.0.113.5, 198.51.100.0/24");
    expect(list).not.toBeNull();
    expect(cidrAllowlistAllows(list!, "203.0.113.5")).toBe(true);
    expect(cidrAllowlistAllows(list!, "203.0.113.6")).toBe(false);
    expect(cidrAllowlistAllows(list!, "198.51.100.123")).toBe(true);
    expect(cidrAllowlistAllows(list!, "198.51.101.1")).toBe(false);
  });

  test("accepts IPv6 subnets", () => {
    const list = parseCidrAllowlist("2001:db8::/32")!;
    expect(cidrAllowlistAllows(list, "2001:db8::1")).toBe(true);
    expect(cidrAllowlistAllows(list, "2001:db9::1")).toBe(false);
  });

  test("strips ::ffff: IPv4-mapped prefix so v4 addresses over dual-stack match v4 subnets", () => {
    const list = parseCidrAllowlist("10.0.0.0/8")!;
    expect(cidrAllowlistAllows(list, "::ffff:10.1.2.3")).toBe(true);
  });

  test("returns false for non-IP inputs without throwing", () => {
    const list = parseCidrAllowlist("10.0.0.0/8")!;
    expect(cidrAllowlistAllows(list, "")).toBe(false);
    expect(cidrAllowlistAllows(list, "not-an-ip")).toBe(false);
  });

  test("always admits loopback when an allowlist is configured", () => {
    // Without this carve-out, the same-process backend caller (e.g. local
    // Claude SDK routing through /llm/anthropic) would be rejected the
    // moment E2B_EGRESS_CIDRS is set in production.
    const list = parseCidrAllowlist("203.0.113.0/24")!;
    expect(cidrAllowlistAllows(list, "127.0.0.1")).toBe(true);
    expect(cidrAllowlistAllows(list, "::1")).toBe(true);
    expect(cidrAllowlistAllows(list, "::ffff:127.0.0.1")).toBe(true);
    // Other private ranges remain blocked — the carve-out is loopback only.
    expect(cidrAllowlistAllows(list, "10.0.0.1")).toBe(false);
    expect(cidrAllowlistAllows(list, "192.168.1.1")).toBe(false);
  });

  test("rejects malformed entries at construction time", () => {
    expect(() => parseCidrAllowlist("not-an-ip")).toThrow();
    expect(() => parseCidrAllowlist("10.0.0.0/abc")).toThrow();
    expect(() => parseCidrAllowlist("10.0.0.0/40")).toThrow();
    expect(() => parseCidrAllowlist("2001:db8::/200")).toThrow();
  });
});
