import { describe, expect, it } from "vitest";

import {
  normalizeSandboxEgressDomains,
  parseSandboxEgressDomain,
  SANDBOX_EGRESS_DOMAIN_MAX_LENGTH,
  SANDBOX_EGRESS_DOMAINS_MAX,
  SandboxEgressDomainsSchema,
  validateSandboxEgressDomains,
  type SandboxEgressErrorCode
} from "@cogniplane/shared-types/sandbox-egress";

// The provider (E2B) accepted every one of the rejected entries below when we
// sent them in a live test: uppercase, a scheme, a port, an IP address, `*`,
// `*.com`, `localhost` and `metadata.google.internal`. The only check is this
// one, so each rule has a case.
describe("parseSandboxEgressDomain", () => {
  it.each([
    "example.com",
    "pypi.org",
    "files.pythonhosted.org",
    "registry.npmjs.org",
    "api.github.com",
    "xn--bcher-kva.de",
    "a-b.example.co.uk",
    "foo.github.io",
    // An exact host can be a shared platform's own name. It names one host.
    "raw.githubusercontent.com",
    "*.example.com",
    "*.example.co.uk",
    "*.foo.github.io",
    "*.city.kobe.jp",
    // An exception to the registry-wide rule *.ck makes www.ck registrable.
    "*.www.ck"
  ])("accepts %s", (entry) => {
    const result = parseSandboxEgressDomain(entry);
    expect(result).toMatchObject({ ok: true, value: { domain: entry } });
  });

  it("tells an exact host from a wildcard and returns the host without the star", () => {
    expect(parseSandboxEgressDomain("example.com")).toEqual({
      ok: true,
      value: { domain: "example.com", wildcard: false, host: "example.com" }
    });
    expect(parseSandboxEgressDomain("*.example.com")).toEqual({
      ok: true,
      value: { domain: "*.example.com", wildcard: true, host: "example.com" }
    });
  });

  const rejected: Array<[string, unknown, SandboxEgressErrorCode]> = [
    ["a number", 42, "not_a_string"],
    ["an empty string", "", "empty"],
    ["leading space", " example.com", "whitespace"],
    ["trailing space", "example.com ", "whitespace"],
    ["an inner space", "exam ple.com", "whitespace"],
    ["a newline", "example.com\n", "whitespace"],
    ["upper case", "Example.com", "uppercase"],
    ["upper case wildcard", "*.EXAMPLE.com", "uppercase"],
    ["a scheme", "https://example.com", "scheme"],
    ["a scheme with a path", "http://example.com/a", "scheme"],
    ["user info", "user@example.com", "userinfo"],
    ["a path", "example.com/path", "path"],
    ["a query", "example.com?x=1", "path"],
    ["a fragment", "example.com#x", "path"],
    ["a backslash", "example.com\\x", "path"],
    ["a port", "example.com:443", "port_or_ip"],
    ["an IPv6 address", "[::1]", "port_or_ip"],
    ["an IPv6 address without brackets", "2606:4700::1111", "port_or_ip"],
    ["a lone star", "*", "bad_wildcard"],
    ["a star that is not a whole first label", "a*.example.com", "bad_wildcard"],
    ["a star in the middle", "www.*.example.com", "bad_wildcard"],
    ["two stars", "*.*.example.com", "bad_wildcard"],
    ["a star without a dot", "*example.com", "bad_wildcard"],
    ["an underscore", "a_b.example.com", "bad_characters"],
    ["a non-ASCII name", "bücher.de", "bad_characters"],
    ["an empty label", "a..example.com", "bad_label"],
    ["a trailing dot", "example.com.", "bad_label"],
    ["a leading dot", ".example.com", "bad_label"],
    ["a label that starts with a hyphen", "-a.example.com", "bad_label"],
    ["a label that ends with a hyphen", "a-.example.com", "bad_label"],
    ["a label of 64 characters", `${"a".repeat(64)}.example.com`, "bad_label"],
    ["an IPv4 address", "93.184.216.34", "ip_address"],
    ["a short IPv4 form", "127.1", "ip_address"],
    ["a decimal IPv4 address", "2130706433", "ip_address"],
    ["a hexadecimal IPv4 address", "0x7f.0x0.0x0.0x1", "ip_address"],
    ["a single label", "intranet", "single_label"],
    ["localhost", "localhost", "single_label"],
    ["a name under localhost", "foo.localhost", "special_use"],
    ["the cloud metadata name", "metadata.google.internal", "special_use"],
    ["a .local name", "printer.local", "special_use"],
    ["a .onion name", "x.onion", "special_use"],
    ["a reserved test name", "example.test", "special_use"],
    ["a suffix that is not on the public list", "foo.corpx", "unknown_suffix"],
    ["a star over a top-level domain", "*.com", "public_suffix_wildcard"],
    ["a star over a country suffix", "*.co.uk", "public_suffix_wildcard"],
    ["a star over a private suffix", "*.github.io", "public_suffix_wildcard"],
    ["a star over a hosting suffix", "*.vercel.app", "public_suffix_wildcard"],
    ["a star over an object-storage suffix", "*.s3.amazonaws.com", "public_suffix_wildcard"],
    ["a star over a suffix whose children are suffixes", "*.kobe.jp", "public_suffix_wildcard"],
    ["a star over a private suffix whose children are suffixes", "*.compute.amazonaws.com", "public_suffix_wildcard"],
    ["a star over a name that a registry-wide rule makes a suffix", "*.foo.ck", "public_suffix_wildcard"],
    ["a name that is too long", `${"a".repeat(SANDBOX_EGRESS_DOMAIN_MAX_LENGTH)}.com`, "too_long"]
  ];
  it.each(rejected)("rejects %s", (_label, entry, code) => {
    const result = parseSandboxEgressDomain(entry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(code);
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it("accepts a name at the length limit and rejects one past it", () => {
    const first = "a".repeat(60);
    const second = "b".repeat(60);
    const atLimit = `${first}.${second}.cc.com`;
    expect(atLimit).toHaveLength(SANDBOX_EGRESS_DOMAIN_MAX_LENGTH);
    expect(parseSandboxEgressDomain(atLimit).ok).toBe(true);
    const pastLimit = `${first}.${second}.ccc.com`;
    expect(pastLimit).toHaveLength(SANDBOX_EGRESS_DOMAIN_MAX_LENGTH + 1);
    expect(parseSandboxEgressDomain(pastLimit)).toMatchObject({ ok: false, code: "too_long" });
  });
});

describe("validateSandboxEgressDomains", () => {
  it("sorts and removes duplicates", () => {
    expect(validateSandboxEgressDomains(["pypi.org", "*.example.com", "pypi.org"])).toEqual({
      ok: true,
      domains: ["*.example.com", "pypi.org"]
    });
  });

  it("accepts an empty list: no network", () => {
    expect(validateSandboxEgressDomains([])).toEqual({ ok: true, domains: [] });
  });

  it("names each failing entry and keeps its position", () => {
    const result = validateSandboxEgressDomains(["pypi.org", "*.com", "bad host"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.index)).toEqual([1, 2]);
    expect(result.issues[0]!.message).toContain('"*.com"');
    expect(result.issues[0]!.message).toContain("public suffix");
    expect(result.issues[1]!.message).toContain('"bad host"');
  });

  it("refuses a list over the limit, counted after duplicates are removed", () => {
    const many = Array.from({ length: SANDBOX_EGRESS_DOMAINS_MAX + 1 }, (_, i) => `host${i}.example.com`);
    expect(validateSandboxEgressDomains(many).ok).toBe(false);
    expect(validateSandboxEgressDomains(many.slice(0, SANDBOX_EGRESS_DOMAINS_MAX)).ok).toBe(true);
    // Duplicates do not count twice.
    expect(validateSandboxEgressDomains([...many.slice(0, SANDBOX_EGRESS_DOMAINS_MAX), many[0]]).ok).toBe(true);
  });

  it("refuses something that is not a list, and a list that is far too large", () => {
    expect(validateSandboxEgressDomains("pypi.org").ok).toBe(false);
    expect(validateSandboxEgressDomains(null).ok).toBe(false);
    expect(validateSandboxEgressDomains(Array.from({ length: 500 }, () => "pypi.org")).ok).toBe(false);
  });

  it("normalizeSandboxEgressDomains is order-insensitive", () => {
    expect(normalizeSandboxEgressDomains(["b.example.com", "a.example.com", "b.example.com"]))
      .toEqual(["a.example.com", "b.example.com"]);
  });
});

describe("SandboxEgressDomainsSchema", () => {
  it("accepts a valid list", () => {
    expect(SandboxEgressDomainsSchema.safeParse(["pypi.org", "*.example.com"]).success).toBe(true);
  });

  it("reports one issue per failing entry, with its position", () => {
    const parsed = SandboxEgressDomainsSchema.safeParse(["pypi.org", "https://example.com", "*"]);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.map((issue) => issue.path)).toEqual([[1], [2]]);
    expect(parsed.error.issues[0]!.message).toContain("scheme");
    expect(parsed.error.issues[1]!.message).toContain("first label");
  });

  it("rejects a list with a non-string entry", () => {
    expect(SandboxEgressDomainsSchema.safeParse(["pypi.org", 3]).success).toBe(false);
  });
});
