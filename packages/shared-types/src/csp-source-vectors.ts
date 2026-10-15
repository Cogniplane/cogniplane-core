// Test vectors for the content security policy sources of MCP app widgets.
// The backend tests run them against `csp-sources.ts`. The frontend tests run
// them against the same file and against the script of the sandbox page, which
// has its own copy of the rules. Add a case here, not in one test file.
//
// `needsSuffixList` marks a case that only the public suffix list can decide,
// such as *.co.uk. The sandbox page has no list, so its tests skip these cases.
// The backend checks every approved source against the list before it stores it.

import type { CspSourceErrorCode, McpAppCspDirective } from "./mcp-app-csp.js";

export type CspSourceVector = {
  name: string;
  directive: McpAppCspDirective;
  source: string;
  /** Why the source fails. Null means that it is valid. */
  reason: CspSourceErrorCode | null;
  /** The source in the form that goes into a policy. Only for a valid source. */
  normalized?: string;
  needsSuffixList?: boolean;
};

const valid = (name: string, source: string, normalized = source,
  directive: McpAppCspDirective = "connectDomains"): CspSourceVector =>
  ({ name, directive, source, reason: null, normalized });
const invalid = (name: string, source: string, reason: CspSourceErrorCode,
  extra: { directive?: McpAppCspDirective; needsSuffixList?: boolean } = {}): CspSourceVector =>
  ({ name, directive: extra.directive ?? "connectDomains", source, reason,
    ...(extra.needsSuffixList ? { needsSuffixList: true } : {}) });

export const CSP_SOURCE_VECTORS: readonly CspSourceVector[] = [
  valid("an exact host", "https://cdn.example.com"),
  valid("a wildcard on a registered domain", "https://*.example.com"),
  valid("a wildcard below a registered domain", "https://*.cdn.example.com"),
  valid("a wildcard on a registered domain below a public suffix", "https://*.example.co.uk"),
  valid("a port", "https://api.example.com:8443"),
  valid("the default port, which is dropped", "https://api.example.com:443", "https://api.example.com"),
  valid("capital letters, which become lower case", "HTTPS://CDN.Example.COM", "https://cdn.example.com"),
  valid("an international name in xn-- form", "https://xn--bcher-kva.example.com"),
  valid("a wildcard on a name that a list exception makes registrable", "https://*.city.kobe.jp"),
  valid("a wildcard on a name that an exception to a registry-wide rule makes registrable", "https://*.www.ck"),
  valid("an exact host that is a private suffix", "https://s3.amazonaws.com"),
  valid("a secure web socket for network requests", "wss://live.example.com"),
  valid("a secure web socket with a port", "wss://live.example.com:9443"),
  valid("an exact host for scripts and images", "https://cdn.example.com", "https://cdn.example.com", "resourceDomains"),
  valid("an exact host for frames", "https://embed.example.com", "https://embed.example.com", "frameDomains"),
  valid("an exact host for the base URL", "https://base.example.com", "https://base.example.com", "baseUriDomains"),

  invalid("a wildcard on a top-level domain", "https://*.com", "public_suffix_wildcard"),
  invalid("a wildcard on a two-label public suffix", "https://*.co.uk", "public_suffix_wildcard", { needsSuffixList: true }),
  invalid("a wildcard on a private suffix", "https://*.github.io", "public_suffix_wildcard", { needsSuffixList: true }),
  invalid("a wildcard on a private suffix with a subdomain", "https://*.s3.amazonaws.com", "public_suffix_wildcard", { needsSuffixList: true }),
  // The list rule *.kobe.jp makes every name below kobe.jp a suffix. The parent is
  // registrable, but one approval would cover unrelated parties.
  invalid("a wildcard on a parent whose children are public suffixes", "https://*.kobe.jp", "public_suffix_wildcard", { needsSuffixList: true }),
  invalid("a wildcard on a parent whose children are private suffixes", "https://*.compute.amazonaws.com", "public_suffix_wildcard", { needsSuffixList: true }),
  // The list rule *.ck makes foo.ck a suffix, so *.foo.ck would cover everything below it.
  invalid("a wildcard on a name that a registry-wide rule makes a suffix", "https://*.foo.ck", "public_suffix_wildcard", { needsSuffixList: true }),
  invalid("a wildcard on its own", "https://*", "bad_wildcard"),
  invalid("two wildcards", "https://*.*.example.com", "bad_wildcard"),
  invalid("a wildcard in the middle", "https://cdn.*.example.com", "bad_wildcard"),
  invalid("a wildcard at the end", "https://example.*", "bad_wildcard"),
  invalid("a wildcard that is part of a label", "https://cdn*.example.com", "bad_wildcard"),
  invalid("a wildcard for any port", "https://example.com:*", "bad_port"),

  invalid("a loopback address", "https://127.0.0.1", "ip_address"),
  invalid("a private address with a port", "https://10.0.0.8:8443", "ip_address"),
  invalid("a link-local address", "https://169.254.169.254", "ip_address"),
  invalid("an address in decimal form", "https://2130706433", "ip_address"),
  invalid("an address in hexadecimal form", "https://0x7f.0.0.1", "ip_address"),
  invalid("an address with fewer than four parts", "https://127.1", "ip_address"),
  invalid("an IPv6 loopback address", "https://[::1]", "ip_address"),
  invalid("an IPv6 link-local address with a port", "https://[fe80::1]:8443", "ip_address"),
  invalid("an IPv4-mapped IPv6 address", "https://[::ffff:127.0.0.1]", "ip_address"),
  invalid("an IPv6 address with no brackets", "https://::1", "ip_address"),

  invalid("localhost", "https://localhost", "special_use_host"),
  invalid("localhost with a port", "https://localhost:8443", "special_use_host"),
  invalid("a name below localhost", "https://app.localhost", "special_use_host"),
  invalid("a .local name", "https://printer.local", "special_use_host"),
  invalid("an .internal name", "https://db.internal", "special_use_host"),
  invalid("a wildcard on an .internal name", "https://*.internal", "special_use_host"),
  invalid("a .test name", "https://widgets.test", "special_use_host"),
  invalid("an .invalid name", "https://widgets.invalid", "special_use_host"),
  invalid("an .example name", "https://widgets.example", "special_use_host"),
  invalid("a .lan name", "https://router.lan", "special_use_host"),
  invalid("a home.arpa name", "https://nas.home.arpa", "special_use_host"),
  invalid("a .localdomain name", "https://box.localdomain", "special_use_host"),

  invalid("a user name", "https://user@example.com", "userinfo"),
  invalid("a user name and password", "https://user:secret@example.com", "userinfo"),
  invalid("a host that hides behind a user name", "https://example.com@attacker.example.net", "userinfo"),

  invalid("a path", "https://example.com/assets", "path"),
  invalid("a trailing slash", "https://example.com/", "path"),
  invalid("a query", "https://example.com?x=1", "path"),
  invalid("a fragment", "https://example.com#top", "path"),
  invalid("a semicolon that starts another directive", "https://example.com;frame-src *", "forbidden_characters"),
  invalid("a space that starts another source", "https://example.com 'unsafe-inline'", "forbidden_characters"),
  invalid("a comma that starts another source", "https://example.com,https://attacker.example.net", "forbidden_characters"),
  invalid("a quote", "https://exam\"ple.com", "forbidden_characters"),
  invalid("an angle bracket", "https://example.com<", "forbidden_characters"),
  invalid("a backslash", "https://example.com\\attacker.example.net", "forbidden_characters"),
  invalid("a percent sign", "https://example%2ecom", "forbidden_characters"),
  invalid("a new line", "https://example.com\nframe-src *", "forbidden_characters"),
  invalid("a name that is not ASCII", "https://bücher.example.com", "forbidden_characters"),
  invalid("a keyword", "'self'", "forbidden_characters"),

  invalid("plain http", "http://example.com", "scheme_not_allowed"),
  invalid("an insecure web socket", "ws://live.example.com", "scheme_not_allowed"),
  invalid("a scheme alone", "https:", "scheme_not_allowed"),
  invalid("a data scheme", "data:", "scheme_not_allowed"),
  invalid("a bare star", "*", "scheme_not_allowed"),
  invalid("no scheme", "cdn.example.com", "scheme_not_allowed"),
  invalid("a web socket in a list that is not for network requests", "wss://live.example.com", "scheme_not_allowed",
    { directive: "resourceDomains" }),
  invalid("a web socket for frames", "wss://live.example.com", "scheme_not_allowed", { directive: "frameDomains" }),

  invalid("port zero", "https://example.com:0", "bad_port"),
  invalid("a port above the range", "https://example.com:65536", "bad_port"),
  invalid("a colon with no port", "https://example.com:", "bad_port"),
  invalid("a port with a leading zero", "https://example.com:08080", "bad_port"),
  invalid("a port with a letter", "https://example.com:80a", "bad_port"),

  invalid("a trailing dot", "https://example.com.", "bad_host"),
  invalid("an empty label", "https://a..example.com", "bad_host"),
  invalid("a label that starts with a hyphen", "https://-a.example.com", "bad_host"),
  invalid("a label with an underscore", "https://exa_mple.com", "bad_host"),
  invalid("a single label", "https://intranet-portal", "bad_host"),
  invalid("a top-level domain as an exact host", "https://com", "bad_host"),
  invalid("no host", "https://", "bad_host"),
  invalid("an empty source", "", "empty"),
  invalid("a source that is too long", `https://${"a".repeat(300)}.example.com`, "too_long")
];

/** A declaration and an approval are each one list of sources per source list. */
export type CspLists = Partial<Record<McpAppCspDirective, string[]>>;

export type CspIntersectionVector = {
  name: string;
  declared: CspLists;
  approved: CspLists;
  /** What the widget may use. A list the widget did not declare is absent. */
  allowed: CspLists;
  needsSuffixList?: boolean;
};

export const CSP_INTERSECTION_VECTORS: readonly CspIntersectionVector[] = [
  {
    name: "an approved wildcard covers subdomains and narrower wildcards",
    approved: { connectDomains: ["https://*.example.com"] },
    declared: { connectDomains: [
      "https://cdn.example.com", "https://a.b.example.com", "https://*.api.example.com", "https://*.example.com"
    ] },
    allowed: { connectDomains: [
      "https://cdn.example.com", "https://a.b.example.com", "https://*.api.example.com", "https://*.example.com"
    ] }
  },
  {
    name: "an approved wildcard does not cover its own apex",
    approved: { connectDomains: ["https://*.example.com"] },
    declared: { connectDomains: ["https://example.com"] },
    allowed: { connectDomains: [] }
  },
  {
    name: "look-alike hosts are not covered",
    approved: { connectDomains: ["https://*.example.com", "https://cdn.example.org"] },
    declared: { connectDomains: [
      "https://evilexample.com", "https://example.com.attacker.example.net", "https://cdn.example.org.attacker.example.net",
      "https://xcdn.example.org"
    ] },
    allowed: { connectDomains: [] }
  },
  {
    name: "an unapproved exact host fails",
    approved: { connectDomains: ["https://cdn.example.com"] },
    declared: { connectDomains: ["https://cdn.example.com", "https://attacker.example.net"] },
    allowed: { connectDomains: ["https://cdn.example.com"] }
  },
  {
    name: "an approved exact host does not cover a subdomain or a wildcard",
    approved: { connectDomains: ["https://example.com"] },
    declared: { connectDomains: ["https://a.example.com", "https://*.example.com"] },
    allowed: { connectDomains: [] }
  },
  {
    name: "nothing is approved at the start, so every declaration is dropped",
    approved: {},
    declared: {
      resourceDomains: ["https://cdn.example.com"],
      connectDomains: ["https://api.example.com"],
      frameDomains: ["https://embed.example.com"],
      baseUriDomains: ["https://base.example.com"]
    },
    allowed: { resourceDomains: [], connectDomains: [], frameDomains: [], baseUriDomains: [] }
  },
  {
    name: "an approval applies to one source list only",
    approved: { connectDomains: ["https://api.example.com"] },
    declared: { resourceDomains: ["https://api.example.com"], connectDomains: ["https://api.example.com"],
      frameDomains: ["https://api.example.com"], baseUriDomains: ["https://api.example.com"] },
    allowed: { resourceDomains: [], connectDomains: ["https://api.example.com"], frameDomains: [], baseUriDomains: [] }
  },
  {
    name: "each source list uses its own approvals",
    approved: { resourceDomains: ["https://cdn.example.com"], frameDomains: ["https://embed.example.com"] },
    declared: { resourceDomains: ["https://cdn.example.com", "https://embed.example.com"],
      frameDomains: ["https://embed.example.com", "https://cdn.example.com"] },
    allowed: { resourceDomains: ["https://cdn.example.com"], frameDomains: ["https://embed.example.com"] }
  },
  {
    name: "the port must match",
    approved: { connectDomains: ["https://api.example.com", "https://other.example.com:8443"] },
    declared: { connectDomains: [
      "https://api.example.com:8443", "https://api.example.com:443", "https://other.example.com", "https://other.example.com:8443"
    ] },
    allowed: { connectDomains: ["https://api.example.com", "https://other.example.com:8443"] }
  },
  {
    name: "the scheme must match",
    approved: { connectDomains: ["https://api.example.com", "wss://live.example.com"] },
    declared: { connectDomains: ["wss://api.example.com", "https://live.example.com", "wss://live.example.com"] },
    allowed: { connectDomains: ["wss://live.example.com"] }
  },
  {
    name: "case does not matter, and the result is in normal form",
    approved: { connectDomains: ["https://CDN.example.com"] },
    declared: { connectDomains: ["https://cdn.EXAMPLE.com", "https://CDN.example.com"] },
    allowed: { connectDomains: ["https://cdn.example.com"] }
  },
  {
    name: "a declared source that is not valid fails even when an approval names it",
    approved: { connectDomains: ["https://127.0.0.1", "https://localhost", "https://*.com", "https://example.com/path"] },
    declared: { connectDomains: ["https://127.0.0.1", "https://localhost", "https://*.com", "https://example.com/path"] },
    allowed: { connectDomains: [] }
  },
  {
    name: "an approved wildcard cannot let a wildcard on a public suffix through",
    approved: { connectDomains: ["https://*.co.uk", "https://*.github.io"] },
    declared: { connectDomains: ["https://*.co.uk", "https://*.github.io"] },
    allowed: { connectDomains: [] },
    needsSuffixList: true
  },
  {
    name: "an approved wildcard on a parent whose children are suffixes covers nothing",
    approved: { connectDomains: ["https://*.kobe.jp", "https://*.foo.ck"] },
    declared: { connectDomains: ["https://a.kobe.jp", "https://*.kobe.jp", "https://x.foo.ck"] },
    allowed: { connectDomains: [] },
    needsSuffixList: true
  },
  {
    name: "a source with a user name does not ride on an approved host",
    approved: { connectDomains: ["https://example.com"] },
    declared: { connectDomains: ["https://user@example.com", "https://example.com@attacker.example.net"] },
    allowed: { connectDomains: [] }
  }
];
