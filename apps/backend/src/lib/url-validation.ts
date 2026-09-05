import type { fetch as undiciFetch } from "undici";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

import { Agent } from "undici";
import { z } from "zod";

// Strict canonical dotted-decimal IPv4 (each octet 1-3 decimal digits).
const CANONICAL_IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

// "Numeric-shaped" hostnames: digits, dots, and `x`/`X` only. A real DNS name
// has at least one alpha character that isn't `x`. If a hostname is numeric-
// shaped but doesn't match canonical IPv4, the OS resolver may still interpret
// it as an IP via legacy formats (octal `0177.0.0.1`,
// 32-bit integer `2130706433`, 2- or 3-segment forms `127.1` / `127.0.1`).
// Any of those would let an admin bypass the SSRF guard, so fail closed.
const NUMERIC_SHAPED = /^[0-9.xX]+$/;

// Hex-encoded IPv4, which `NUMERIC_SHAPED` alone does NOT catch: it permits
// the `x` but not the digits `a`-`f`, so `0xA9FEA9FE` fell through to "public"
// and resolved to 169.254.169.254 — cloud instance metadata.
//
// Match on the `0x` PREFIX rather than on hex characters generally. That is
// exactly the resolver's own rule, confirmed by probing it: a component
// starting `0x` is parsed as a number (`0xA9FEA9FE`, `0X7F000001`,
// `0x7f.0.0.1`, `0xff.0xff.0xff.0xfe`, `0x7f.1` all resolve), while a bare hex
// word is an ordinary hostname (`cafe`, `dead`, `face`, `ffff` do not). A
// blanket `[0-9a-fA-F.]+` test would block those legitimate names.
const HEX_IP_SHAPED = /^(?:0[xX][0-9a-fA-F]*)(?:\.(?:0[xX])?[0-9a-fA-F]*)*$/;

// Classifies a canonical dotted-decimal IPv4 string. Returns `true` for
// private/reserved ranges, `false` for public. Used both for bare IPv4 hosts
// and for the IPv4 quad embedded in IPv4-mapped / NAT64 IPv6 literals.
function isPrivateOrReservedIpv4(host: string): boolean {
  const ipv4Match = CANONICAL_IPV4.exec(host);
  if (!ipv4Match) {
    // Not a canonical quad. Fail closed — the caller only reaches here for
    // strings already known to be IP-shaped.
    return true;
  }

  const octets = ipv4Match.slice(1);
  // Leading zero on a multi-digit octet is non-canonical: glibc and many
  // resolvers parse `0177` as octal 127. Refuse admission.
  if (octets.some((octet) => octet.length > 1 && octet.startsWith("0"))) {
    return true;
  }
  const numbers = octets.map(Number);
  if (numbers.some((n) => n > 255)) return true;
  const [a, b] = numbers;
  if (a === 0) return true;                           // 0.0.0.0/8
  if (a === 10) return true;                          // 10.0.0.0/8
  if (a === 100 && b! >= 64 && b! <= 127) return true; // 100.64.0.0/10 (shared)
  if (a === 127) return true;                         // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true;            // 169.254.0.0/16 (IMDS, link-local)
  if (a === 172 && b! >= 16 && b! <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true;            // 192.168.0.0/16
  if (a === 255) return true;                         // broadcast
  return false;
}

/**
 * Expands an IPv6 literal (already validated by `node:net`'s `isIP`) into its
 * eight 16-bit hextet values. Handles `::` zero-run compression and the
 * trailing-IPv4 dotted form (`::ffff:1.2.3.4`). Returns `null` if the literal
 * is malformed in a way `isIP` would not have rejected — callers fail closed.
 */
function expandIpv6(host: string): number[] | null {
  // A zone index (`fe80::1%eth0`) is never routable off-host; strip it but the
  // presence of one already implies link-local — treat as blocked by returning
  // null at the call site is unnecessary because the prefix check covers it.
  const withoutZone = host.split("%")[0]!;

  const halves = withoutZone.split("::");
  if (halves.length > 2) {
    return null;
  }

  const parseGroups = (segment: string): number[] | null => {
    if (segment === "") return [];
    const parts = segment.split(":");
    const groups: number[] = [];
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i]!;
      // Trailing dotted-quad form: only valid as the final segment.
      if (part.includes(".")) {
        if (i !== parts.length - 1) return null;
        const quadMatch = CANONICAL_IPV4.exec(part);
        if (!quadMatch) return null;
        const q = quadMatch.slice(1).map(Number);
        if (q.some((n) => n > 255)) return null;
        groups.push((q[0]! << 8) | q[1]!, (q[2]! << 8) | q[3]!);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
      groups.push(parseInt(part, 16));
    }
    return groups;
  };

  const head = parseGroups(halves[0]!);
  if (head === null) return null;

  if (halves.length === 1) {
    return head.length === 8 ? head : null;
  }

  const tail = parseGroups(halves[1]!);
  if (tail === null) return null;

  const zeros = 8 - head.length - tail.length;
  if (zeros < 0) return null;
  return [...head, ...new Array(zeros).fill(0), ...tail];
}

export function isPrivateOrReservedHost(hostname: string): boolean {
  const host =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;

  if (isIP(host) === 4) {
    return isPrivateOrReservedIpv4(host);
  }

  // Numeric-shaped but not a valid IPv4 → unusual format the resolver may still
  // treat as an IP (octal `0177.0.0.1`, 32-bit integer, 2-/3-segment short
  // forms). Block it. `HEX_IP_SHAPED` covers the `0x`-prefixed forms, which
  // NUMERIC_SHAPED cannot express.
  if (NUMERIC_SHAPED.test(host) || HEX_IP_SHAPED.test(host)) {
    return true;
  }

  if (isIP(host) === 6) {
    const groups = expandIpv6(host);
    // Unparseable despite passing isIP → fail closed.
    if (groups === null) return true;

    // Unspecified (::) and loopback (::1).
    if (groups.every((g) => g === 0)) return true;
    if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true;

    // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d, deprecated):
    // re-run the IPv4 classifier on the embedded quad. `::ffff:169.254.169.254`
    // must be blocked exactly like the bare IMDS address.
    const firstFiveZero = groups.slice(0, 5).every((g) => g === 0);
    if (firstFiveZero && (groups[5] === 0xffff || groups[5] === 0)) {
      const a = (groups[6]! >> 8) & 0xff;
      const b = groups[6]! & 0xff;
      const c = (groups[7]! >> 8) & 0xff;
      const d = groups[7]! & 0xff;
      // ::/96-embedded ::0.0.0.0 is the unspecified address (already blocked
      // above), so a bare `::` here is not reachable; classify the quad.
      return isPrivateOrReservedIpv4(`${a}.${b}.${c}.${d}`);
    }

    // NAT64 well-known prefix 64:ff9b::/96 — embeds an arbitrary IPv4 the
    // gateway will translate to, so classify the embedded quad and, since any
    // NAT64 destination is operator-internal infrastructure, block outright.
    if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
      return true;
    }

    // fc00::/7 unique-local and fe80::/10 link-local.
    if ((groups[0]! & 0xfe00) === 0xfc00) return true;       // fc00::/7
    if ((groups[0]! & 0xffc0) === 0xfe80) return true;       // fe80::/10

    return false;
  }

  return false;
}

/**
 * Custom DNS lookup hook for the SSRF-safe undici agent. Resolves all A/AAAA
 * records for the host, refuses the whole lookup if ANY of them is
 * private/reserved (defends against multi-record `(public, private)` rebinding
 * tricks), and otherwise hands back that validated snapshot for Node to
 * connect from.
 *
 * The error message intentionally does not include the resolved IP — surfacing
 * an internal IP in error responses would itself be a small information leak
 * to the attacker who provoked the failure.
 */
export type LookupAddress = { address: string; family: number };

/**
 * undici invokes this hook with `{ hints, all: true }`, and Node's contract for
 * `all: true` is that the callback receives an ARRAY of `{address, family}` —
 * NOT the `(err, address, family)` triple used by the single-address form.
 *
 * This is load-bearing, not a detail. Passing the triple makes undici read an
 * address off an array it never received and fail every connection with
 * "Invalid IP address: undefined" — which looks like the guard refusing a host
 * while actually being the guard not running at all. Any change here must be
 * verified against the installed undici, through a real request, not against
 * this function alone.
 */
type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  addresses?: LookupAddress[]
) => void;

export async function ssrfSafeLookup(
  hostname: string,
  _options: unknown,
  callback: LookupCallback
): Promise<void> {
  try {
    const records = await dnsLookup(hostname, { all: true, verbatim: true });
    if (records.length === 0) {
      callback(new Error("DNS lookup returned no records.") as NodeJS.ErrnoException);
      return;
    }
    for (const record of records) {
      if (isPrivateOrReservedHost(record.address)) {
        callback(
          new Error(
            "Refusing to connect: hostname resolves to a private or reserved address."
          ) as NodeJS.ErrnoException
        );
        return;
      }
    }
    // Hand back the WHOLE validated snapshot, not just the first record.
    //
    // What closes the rebinding window is the loop above: the lookup is
    // refused outright if ANY resolved record is private or reserved, and the
    // addresses returned here are exactly the ones that passed. Node connects
    // from this array without resolving again — verified: with two records it
    // failed over from an unreachable address to a live one after a SINGLE
    // lookup call — so no unvalidated address can enter at connect time.
    //
    // Returning only records[0] was therefore not a security measure, just a
    // needless loss of failover: a dual-stack or multi-homed upstream whose
    // first record happens to be down would fail even though a validated,
    // reachable address was available.
    callback(
      null,
      records.map((record) => ({ address: record.address, family: record.family }))
    );
  } catch (err) {
    callback(err as NodeJS.ErrnoException);
  }
}

/**
 * Singleton undici Agent that re-validates every outbound DNS lookup against
 * the private/reserved-IP block list and pins the connection to the resolved
 * address. Pass via `dispatcher: ssrfSafeAgent` on any `fetch()` call whose
 * URL is admin- or tenant-supplied (MCP proxy upstreams, marketplace manifest
 * URLs, GitHub-archive imports for arbitrary hosts).
 *
 * Use of this agent closes the DNS-rebinding TOCTOU window between
 * `httpsUrlSchema`'s write-time validation and the actual fetch — without
 * pinning, an attacker can serve a public IP at validation time and flip to
 * 127.0.0.1 / 169.254.169.254 at connect time.
 *
 * The hook returns every record that passed validation, so Node's own
 * address failover still works — the guard costs no availability. Note this
 * agent is on the hot path for EVERY forwarded MCP tool call, not only
 * occasional admin actions, so that matters.
 */
export const ssrfSafeAgent = new Agent({
  connect: {
    lookup: ssrfSafeLookup as never
  }
});

/**
 * `ssrfSafeAgent` only takes effect on a fetch that honours the `dispatcher`
 * option — Node's global fetch silently ignores it as of undici v8, which would
 * disable DNS pinning without any visible failure. Call sites accept an
 * injectable fetch (for tests), so enforce the invariant instead of documenting
 * it: passing the global fetch is a wiring bug, not a fallback.
 */
export function assertDispatcherAwareFetch(fetchImpl: typeof undiciFetch): void {
  if (Object.is(fetchImpl, globalThis.fetch)) {
    throw new Error(
      "SSRF-protected fetch must use undici's fetch: Node's global fetch ignores the `dispatcher` option, " +
        "which silently disables DNS pinning."
    );
  }
}

export const httpsUrlSchema = z
  .string()
  .url()
  .refine((url) => url.startsWith("https://"), {
    message: "URL must use the https:// scheme"
  })
  .refine(
    (url) => {
      try {
        return !isPrivateOrReservedHost(new URL(url).hostname);
      } catch {
        return false;
      }
    },
    { message: "URL must not point to a private or reserved IP address" }
  )
  // Reject `https://user:pass@host/...` at write time. A credential embedded
  // here is stored in plaintext (mcp_servers.upstream_url is not an encrypted
  // column), returned to the admin UI on every read, and travels into any log
  // record naming the URL. Refusing it at the boundary is the only place the
  // fix holds for every downstream consumer at once — `logSafeUrl` covers the
  // log path, but nothing can un-store a credential already persisted.
  .refine(
    (url) => {
      try {
        const parsed = new URL(url);
        return parsed.username === "" && parsed.password === "";
      } catch {
        return false;
      }
    },
    { message: "URL must not embed credentials (user:password@)" }
  );

/**
 * Reduce an outbound URL to origin + pathname for logging.
 *
 * Distinct from `sanitize-url.ts`, and the two are not interchangeable.
 * `sanitizeUrl` redacts a known list of parameter NAMES, which works for our
 * own inbound request paths because we own the names. This function is for
 * third-party URLs an admin configured — an MCP proxy upstream, a marketplace
 * manifest — where the query-parameter name is the vendor's choice and no
 * allowlist can anticipate it. So drop the query entirely rather than trying
 * to classify it, and drop userinfo as belt-and-braces for any URL stored
 * before the schema above started rejecting it.
 *
 * Returns the fixed string `"[unparseable url]"` rather than falling back to
 * the raw input: a value that failed `new URL()` is exactly the value least
 * safe to log verbatim. Non-http(s) schemes get the same treatment — `origin`
 * is the string "null" for them, so a `mailto:` or `data:` value would
 * otherwise concatenate into a misleading (and potentially secret-bearing)
 * line rather than failing cleanly.
 *
 * The pathname is dropped too. It was kept at first, on the argument that the
 * path is routing information and no MCP vendor authenticates with a path
 * segment — but nothing in the write path enforces that: `httpsUrlSchema`
 * constrains the scheme, host and userinfo and says nothing about the path, so
 * `https://vendor.example/keys/<API_KEY>/rpc` is an accepted upstream whose key
 * would be copied verbatim into the log on the first transport failure. A
 * convention no code enforces is not a control.
 *
 * Route identity does not depend on the path: callers that need to tell two
 * upstreams on one origin apart log the stable MCP `serverId` alongside this
 * value, which identifies the route better than a path ever did and carries no
 * secret.
 */
export function logSafeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return "[unloggable url scheme]";
    }
    return parsed.origin;
  } catch {
    return "[unparseable url]";
  }
}
