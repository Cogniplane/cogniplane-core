import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { httpsUrlSchema, isPrivateOrReservedHost, logSafeUrl, ssrfSafeLookup } from "./url-validation.js";

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

  it("blocks IPv4-mapped IPv6 literals by classifying the embedded quad", () => {
    expect(isPrivateOrReservedHost("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedHost("::ffff:169.254.169.254")).toBe(true);
    expect(isPrivateOrReservedHost("::ffff:10.0.0.1")).toBe(true);
    // Bracketed form (as it would appear in a URL hostname).
    expect(isPrivateOrReservedHost("[::ffff:169.254.169.254]")).toBe(true);
    // Hex-form IPv4-mapped (::ffff:7f00:1 == ::ffff:127.0.0.1).
    expect(isPrivateOrReservedHost("::ffff:7f00:1")).toBe(true);
    // Public IPv4 mapped through ::ffff: stays allowed.
    expect(isPrivateOrReservedHost("::ffff:8.8.8.8")).toBe(false);
  });

  it("blocks expanded / alternate IPv6 loopback forms", () => {
    expect(isPrivateOrReservedHost("0:0:0:0:0:0:0:1")).toBe(true);
    expect(isPrivateOrReservedHost("0000:0000:0000:0000:0000:0000:0000:0001")).toBe(true);
    expect(isPrivateOrReservedHost("0:0:0:0:0:0:0:0")).toBe(true);
  });

  it("blocks the NAT64 well-known prefix 64:ff9b::/96", () => {
    expect(isPrivateOrReservedHost("64:ff9b::7f00:1")).toBe(true);
    expect(isPrivateOrReservedHost("64:ff9b::8.8.8.8")).toBe(true);
    expect(isPrivateOrReservedHost("64:ff9b::169.254.169.254")).toBe(true);
  });
});

describe("ssrfSafeLookup", () => {
  beforeEach(() => {
    mockedLookup.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Mirrors undici's real contract: it passes `{all: true}`, so the callback
  // receives an ARRAY of {address, family}. The previous version of this
  // helper assumed the (err, address, family) triple, which is why the
  // shape mismatch that broke every outbound request went unnoticed here.
  function callLookup(hostname: string): Promise<{
    err: NodeJS.ErrnoException | null;
    addresses: Array<{ address: string; family: number }>;
  }> {
    return new Promise((resolve) => {
      ssrfSafeLookup(hostname, { hints: 32, all: true }, (err, addresses) => {
        resolve({ err, addresses: addresses ?? [] });
      });
    });
  }

  it("forwards the resolved IP for a public-only hostname", async () => {
    mockedLookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 }
    ] as never);

    const result = await callLookup("example.com");

    expect(result.err).toBeNull();
    expect(result.addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("returns every validated record so Node can still fail over", async () => {
    // All of these passed the private/reserved check, so handing back only the
    // first would drop working addresses for no security gain: Node connects
    // from this array without resolving again.
    mockedLookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }
    ] as never);

    const result = await callLookup("dual-stack.example.com");

    expect(result.err).toBeNull();
    expect(result.addresses).toEqual([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }
    ]);
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
    expect(result.addresses).toEqual([]);
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
    expect(result.addresses).toEqual([]);
  });

  it("rejects RFC1918 IPv4", async () => {
    mockedLookup.mockResolvedValue([
      { address: "10.0.0.5", family: 4 }
    ] as never);

    const result = await callLookup("internal.example.com");

    expect(result.err).not.toBeNull();
    expect(result.addresses).toEqual([]);
  });

  it("rejects IPv6 loopback", async () => {
    mockedLookup.mockResolvedValue([
      { address: "::1", family: 6 }
    ] as never);

    const result = await callLookup("v6loop.example.com");

    expect(result.err).not.toBeNull();
    expect(result.addresses).toEqual([]);
  });

  it("surfaces underlying DNS errors through the callback", async () => {
    const dnsError = Object.assign(new Error("getaddrinfo ENOTFOUND nope.example.com"), {
      code: "ENOTFOUND"
    });
    mockedLookup.mockRejectedValue(dnsError);

    const result = await callLookup("nope.example.com");

    expect(result.err).toBe(dnsError);
    expect(result.addresses).toEqual([]);
  });

  it("rejects when DNS returns an empty record list", async () => {
    mockedLookup.mockResolvedValue([] as never);

    const result = await callLookup("ghost.example.com");

    expect(result.err).not.toBeNull();
    expect(String(result.err?.message)).toMatch(/no records/);
    expect(result.addresses).toEqual([]);
  });
});

describe("isPrivateOrReservedHost — hex-encoded IPv4", () => {
  // A real bypass, not a hypothetical: `NUMERIC_SHAPED` allows the `x` but not
  // the digits a-f, so `0xA9FEA9FE` was classified public and resolves to
  // 169.254.169.254 — cloud instance metadata. Every value below was checked
  // against the actual resolver: the first group resolves to an IP, the second
  // does not resolve at all and must stay usable as a hostname.
  const resolverTreatsAsIp: Array<[string, string]> = [
    ["hex IMDS", "0xA9FEA9FE"],
    ["hex loopback", "0x7f000001"],
    ["uppercase 0X", "0X7F000001"],
    ["dotted hex", "0x7f.0.0.1"],
    ["all-hex octets", "0xff.0xff.0xff.0xfe"],
    ["short hex form", "0x7f.1"]
  ];

  for (const [label, host] of resolverTreatsAsIp) {
    it(`blocks ${label}: ${host}`, () => {
      expect(isPrivateOrReservedHost(host)).toBe(true);
    });
  }

  const ordinaryHostnames = [
    "cafe",
    "dead",
    "face",
    "ffff",
    "abc",
    "beef.example.com",
    "0xzz.example.com",
    "x.example.com",
    "example.com"
  ];

  for (const host of ordinaryHostnames) {
    it(`still allows the ordinary hostname ${host}`, () => {
      // The over-blocking direction matters just as much: a blanket
      // [0-9a-fA-F.]+ test would have made these unreachable.
      expect(isPrivateOrReservedHost(host)).toBe(false);
    });
  }

  it("leaves IPv6 classification alone", () => {
    // IPv6 literals are hex too; they contain ':' so the hex-IPv4 pattern must
    // not claim them before the IPv6 branch runs.
    expect(isPrivateOrReservedHost("2606:2800:220:1:248:1893:25c8:1946")).toBe(false);
    expect(isPrivateOrReservedHost("::1")).toBe(true);
    expect(isPrivateOrReservedHost("::ffff:169.254.169.254")).toBe(true);
  });
});

describe("logSafeUrl", () => {
  it("drops the query string wholesale", () => {
    // The point of the helper: an admin-configured third-party URL uses the
    // VENDOR's parameter names, so no allowlist of known-sensitive names (the
    // approach sanitize-url.ts takes for our own routes) can be trusted here.
    expect(logSafeUrl("https://mcp.example.com/rpc?api_key=SEKRET")).toBe(
      "https://mcp.example.com"
    );
    expect(logSafeUrl("https://mcp.example.com/rpc?wholly_unknown_name=SEKRET")).toBe(
      "https://mcp.example.com"
    );
  });

  it("drops credentials embedded in userinfo", () => {
    expect(logSafeUrl("https://user:pw@mcp.example.com/rpc")).toBe("https://mcp.example.com");
  });

  it("drops the fragment", () => {
    expect(logSafeUrl("https://mcp.example.com/rpc#tok")).toBe("https://mcp.example.com");
  });

  it("keeps the origin, including a non-default port", () => {
    // Route identity comes from the serverId logged beside this value, not
    // from the path — see the pathname test below.
    expect(logSafeUrl("https://mcp.example.com:8443/a/b/rpc")).toBe("https://mcp.example.com:8443");
  });

  it("returns a fixed marker rather than echoing an unparseable value", () => {
    // A value that failed `new URL()` is the value least safe to log verbatim,
    // so there is deliberately no raw-input fallback.
    const unparseable: string[] = [
      "not a url ?api_key=SEKRET",
      "",
      "   ",
      "/relative/path?api_key=SEKRET",
      "//protocol-relative.example.com/x?api_key=SEKRET",
      "https://",
      "http://[not-an-ipv6/?api_key=SEKRET"
    ];
    for (const value of unparseable) {
      expect(logSafeUrl(value)).toBe("[unparseable url]");
    }
  });

  it("refuses non-http(s) schemes instead of emitting a null origin", () => {
    // `new URL("mailto:...").origin` is the STRING "null", so concatenating
    // origin + pathname would produce a misleading line that can still carry
    // whatever the scheme put in its path.
    const otherSchemes: string[] = [
      "mailto:user:pw@example.com?subject=SEKRET",
      "data:text/plain,SEKRET",
      "file:///etc/SEKRET",
      "ftp://user:pw@example.com/SEKRET",
      "javascript:alert('SEKRET')"
    ];
    for (const value of otherSchemes) {
      const result = logSafeUrl(value);
      expect(result).toBe("[unloggable url scheme]");
      expect(result).not.toContain("SEKRET");
      expect(result).not.toContain("null");
    }
  });

  it("handles IPv6 literals and non-default ports", () => {
    expect(logSafeUrl("https://[2001:db8::1]:8443/rpc?api_key=SEKRET")).toBe(
      "https://[2001:db8::1]:8443"
    );
    expect(logSafeUrl("https://[::1]/rpc")).toBe("https://[::1]");
  });

  it("keeps plain http, which is a legitimate loopback upstream in dev", () => {
    expect(logSafeUrl("http://localhost:3001/mcp?api_key=SEKRET")).toBe("http://localhost:3001");
  });

  it("drops a secret carried in the PATH", () => {
    // httpsUrlSchema constrains scheme, host and userinfo but says nothing
    // about the path, so `/keys/<API_KEY>/rpc` is an accepted upstream. The
    // path is dropped because a convention no code enforces is not a control.
    expect(logSafeUrl("https://mcp.example.com/keys/SEKRET/rpc")).toBe("https://mcp.example.com");
  });
});

describe("httpsUrlSchema — embedded credentials", () => {
  it("rejects user:password@ in the URL", () => {
    // undici refuses to construct a Request from a credentialed URL at all
    // ("Request cannot be constructed from a URL that includes credentials"),
    // and that TypeError echoes the whole URL back. Rejecting at write time
    // keeps the credential out of the database and out of that error path.
    expect(httpsUrlSchema.safeParse("https://user:pw@mcp.example.com/rpc").success).toBe(false);
  });

  it("rejects a username with no password", () => {
    expect(httpsUrlSchema.safeParse("https://user@mcp.example.com/rpc").success).toBe(false);
  });

  it("still accepts an ordinary public https URL with a query", () => {
    expect(httpsUrlSchema.safeParse("https://mcp.example.com/rpc?region=eu").success).toBe(true);
  });
});
