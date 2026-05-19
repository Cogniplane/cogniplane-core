import { describe, it, expect } from "vitest";

import { mcpBodySchema, githubImportBodySchema } from "./admin-route-schemas.js";

const validBase = {
  serverName: "test",
  mode: "proxy" as const,
  routePath: "/mcp/test"
};

describe("httpsUrlSchema — SSRF IP block list", () => {
  const blocked: Array<[string, string]> = [
    ["loopback IPv4", "https://127.0.0.1/"],
    ["loopback IPv4 alt", "https://127.1.2.3/"],
    ["AWS IMDS link-local", "https://169.254.169.254/latest/meta-data/"],
    ["RFC 1918 10/8", "https://10.0.0.1/"],
    ["RFC 1918 172.16/12", "https://172.16.0.1/"],
    ["RFC 1918 172.31/12", "https://172.31.255.254/"],
    ["RFC 1918 192.168/16", "https://192.168.1.1/"],
    ["shared address 100.64/10", "https://100.64.0.1/"],
    ["unspecified 0.0.0.0", "https://0.0.0.0/"],
    ["broadcast 255.255.255.255", "https://255.255.255.255/"],
    ["IPv6 loopback ::1", "https://[::1]/"],
    ["IPv6 unspecified ::", "https://[::]/"],
    ["IPv6 unique-local fc::", "https://[fc00::1]/"],
    ["IPv6 unique-local fd::", "https://[fd12:3456::1]/"],
    ["IPv6 link-local fe80::", "https://[fe80::1]/"]
  ];

  for (const [label, url] of blocked) {
    it(`rejects ${label}: ${url}`, () => {
      const result = mcpBodySchema.safeParse({ ...validBase, upstreamUrl: url });
      expect(result.success).toBe(false);
    });
  }

  it("accepts a valid external HTTPS URL", () => {
    const result = mcpBodySchema.safeParse({
      ...validBase,
      upstreamUrl: "https://api.example.com/mcp"
    });
    expect(result.success).toBe(true);
  });

  it("accepts null upstreamUrl (optional field)", () => {
    const result = mcpBodySchema.safeParse({ ...validBase, upstreamUrl: null });
    expect(result.success).toBe(true);
  });

  it("rejects http:// scheme", () => {
    const result = mcpBodySchema.safeParse({
      ...validBase,
      upstreamUrl: "http://api.example.com/mcp"
    });
    expect(result.success).toBe(false);
  });

  it("githubImportBodySchema also rejects private IPs", () => {
    const result = githubImportBodySchema.safeParse({
      githubUrl: "https://192.168.0.1/owner/repo"
    });
    expect(result.success).toBe(false);
  });
});

describe("httpsUrlSchema — IPv4 numeric-format bypass", () => {
  // Each of these resolves to 127.0.0.1 via the OS resolver but evades a
  // naive dotted-decimal check. The hardened guard treats numeric-shaped
  // hostnames that aren't canonical IPv4 as private/reserved.
  const bypassed: Array<[string, string]> = [
    ["octal-prefixed octet", "https://0177.0.0.1/"],
    ["32-bit integer form", "https://2130706433/"],
    ["hex-prefixed octet", "https://0x7f.0.0.1/"],
    ["short 2-segment form", "https://127.1/"],
    ["short 3-segment form", "https://127.0.1/"],
    ["full hex form", "https://0x7f000001/"],
    ["octal IMDS bypass", "https://0251.0376.0251.0376/"]
  ];

  for (const [label, url] of bypassed) {
    it(`rejects ${label}: ${url}`, () => {
      const result = mcpBodySchema.safeParse({ ...validBase, upstreamUrl: url });
      expect(result.success).toBe(false);
    });
  }

  it("rejects octets greater than 255", () => {
    const result = mcpBodySchema.safeParse({ ...validBase, upstreamUrl: "https://999.0.0.1/" });
    expect(result.success).toBe(false);
  });

  it("still accepts canonical external IPv4 addresses", () => {
    const result = mcpBodySchema.safeParse({ ...validBase, upstreamUrl: "https://8.8.8.8/" });
    expect(result.success).toBe(true);
  });

  it("still accepts normal hostnames containing the letter x", () => {
    const result = mcpBodySchema.safeParse({
      ...validBase,
      upstreamUrl: "https://x.example.com/mcp"
    });
    expect(result.success).toBe(true);
  });
});
