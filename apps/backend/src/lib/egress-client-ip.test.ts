import { test, expect, describe } from "vitest";
import type { FastifyRequest } from "fastify";

import { resolveEgressClientIp } from "./egress-client-ip.js";

function fakeRequest(opts: {
  ip?: string | null;
  ips?: string[];
  headers?: Record<string, string | string[] | undefined>;
}): FastifyRequest {
  return {
    ip: opts.ip ?? undefined,
    ips: opts.ips,
    headers: opts.headers ?? {}
  } as unknown as FastifyRequest;
}

describe("resolveEgressClientIp", () => {
  test("prefers CF-Connecting-IP when the request crossed a trusted proxy hop", () => {
    const request = fakeRequest({
      ip: "172.71.0.9", // Cloudflare edge IP that trustProxy resolved
      ips: ["10.0.0.5", "172.71.0.9"], // socket peer + one trusted XFF hop
      headers: { "cf-connecting-ip": "203.0.113.42" } // the real sandbox egress IP
    });
    expect(resolveEgressClientIp(request)).toBe("203.0.113.42");
  });

  test("ignores CF-Connecting-IP when no trusted proxy hop was crossed (spoof-safe)", () => {
    // A single `ips` entry means trustProxy did not credit any XFF hop, so the
    // header is client-supplied and must not be trusted.
    const request = fakeRequest({
      ip: "203.0.113.7",
      ips: ["203.0.113.7"],
      headers: { "cf-connecting-ip": "10.0.0.1" }
    });
    expect(resolveEgressClientIp(request)).toBe("203.0.113.7");
  });

  test("falls back to request.ip when CF-Connecting-IP is absent", () => {
    const request = fakeRequest({
      ip: "203.0.113.7",
      ips: ["10.0.0.5", "203.0.113.7"]
    });
    expect(resolveEgressClientIp(request)).toBe("203.0.113.7");
  });

  test("falls back to request.ip when trustProxy is disabled (no ips array)", () => {
    const request = fakeRequest({
      ip: "10.0.0.5",
      headers: { "cf-connecting-ip": "10.0.0.1" }
    });
    expect(resolveEgressClientIp(request)).toBe("10.0.0.5");
  });

  test("ignores a blank CF-Connecting-IP and falls back", () => {
    const request = fakeRequest({
      ip: "172.71.0.9",
      ips: ["10.0.0.5", "172.71.0.9"],
      headers: { "cf-connecting-ip": "   " }
    });
    expect(resolveEgressClientIp(request)).toBe("172.71.0.9");
  });

  test("takes the first value when CF-Connecting-IP arrives as an array", () => {
    const request = fakeRequest({
      ip: "172.71.0.9",
      ips: ["10.0.0.5", "172.71.0.9"],
      headers: { "cf-connecting-ip": ["203.0.113.42", "evil"] }
    });
    expect(resolveEgressClientIp(request)).toBe("203.0.113.42");
  });

  test("returns null when there is no resolvable IP at all", () => {
    const request = fakeRequest({ ip: null });
    expect(resolveEgressClientIp(request)).toBeNull();
  });
});
