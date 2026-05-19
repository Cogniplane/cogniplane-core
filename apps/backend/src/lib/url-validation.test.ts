import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { isPrivateOrReservedHost, ssrfSafeLookup } from "./url-validation.js";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn()
}));

// Pull the mocked function back so we can re-stub it per-test.
const dnsPromises = await import("node:dns/promises");
const mockedLookup = vi.mocked(dnsPromises.lookup);

describe("isPrivateOrReservedHost", () => {
  it("blocks loopback / RFC1918 / link-local / IMDS", () => {
    expect(isPrivateOrReservedHost("127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedHost("10.0.0.1")).toBe(true);
    expect(isPrivateOrReservedHost("172.16.0.1")).toBe(true);
    expect(isPrivateOrReservedHost("192.168.1.1")).toBe(true);
    expect(isPrivateOrReservedHost("169.254.169.254")).toBe(true);
    expect(isPrivateOrReservedHost("::1")).toBe(true);
  });

  it("allows ordinary public IPv4 / IPv6", () => {
    expect(isPrivateOrReservedHost("8.8.8.8")).toBe(false);
    expect(isPrivateOrReservedHost("1.1.1.1")).toBe(false);
    expect(isPrivateOrReservedHost("2606:4700:4700::1111")).toBe(false);
  });
});

describe("ssrfSafeLookup", () => {
  beforeEach(() => {
    mockedLookup.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function callLookup(hostname: string): Promise<{
    err: NodeJS.ErrnoException | null;
    address: string;
    family: number;
  }> {
    return new Promise((resolve) => {
      ssrfSafeLookup(hostname, undefined, (err, address, family) => {
        resolve({ err, address, family });
      });
    });
  }

  it("forwards the resolved IP for a public-only hostname", async () => {
    mockedLookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 }
    ] as never);

    const result = await callLookup("example.com");

    expect(result.err).toBeNull();
    expect(result.address).toBe("93.184.216.34");
    expect(result.family).toBe(4);
  });

  it("rejects when the host resolves to a loopback IP", async () => {
    mockedLookup.mockResolvedValue([
      { address: "127.0.0.1", family: 4 }
    ] as never);

    const result = await callLookup("evil.example.com");

    expect(result.err).not.toBeNull();
    expect(String(result.err?.message)).toMatch(/private or reserved/);
    // The resolved IP MUST NOT appear in the error message — leaking it
    // would tell an attacker which internal address their probe hit.
    expect(String(result.err?.message)).not.toMatch(/127\.0\.0\.1/);
    expect(result.address).toBe("");
  });

  it("rejects AWS IMDS link-local even if mixed with a public record", async () => {
    // Multi-record `(public, private)` rebinding trick: defender rejects
    // because at least one resolved address is in a blocked range.
    mockedLookup.mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "169.254.169.254", family: 4 }
    ] as never);

    const result = await callLookup("rebinding.example.com");

    expect(result.err).not.toBeNull();
    expect(String(result.err?.message)).toMatch(/private or reserved/);
    expect(result.address).toBe("");
  });

  it("rejects RFC1918 IPv4", async () => {
    mockedLookup.mockResolvedValue([
      { address: "10.0.0.5", family: 4 }
    ] as never);

    const result = await callLookup("internal.example.com");

    expect(result.err).not.toBeNull();
    expect(result.address).toBe("");
  });

  it("rejects IPv6 loopback", async () => {
    mockedLookup.mockResolvedValue([
      { address: "::1", family: 6 }
    ] as never);

    const result = await callLookup("v6loop.example.com");

    expect(result.err).not.toBeNull();
    expect(result.address).toBe("");
  });

  it("surfaces underlying DNS errors through the callback", async () => {
    const dnsError = Object.assign(new Error("getaddrinfo ENOTFOUND nope.example.com"), {
      code: "ENOTFOUND"
    });
    mockedLookup.mockRejectedValue(dnsError);

    const result = await callLookup("nope.example.com");

    expect(result.err).toBe(dnsError);
    expect(result.address).toBe("");
  });

  it("rejects when DNS returns an empty record list", async () => {
    mockedLookup.mockResolvedValue([] as never);

    const result = await callLookup("ghost.example.com");

    expect(result.err).not.toBeNull();
    expect(String(result.err?.message)).toMatch(/no records/);
    expect(result.address).toBe("");
  });
});
