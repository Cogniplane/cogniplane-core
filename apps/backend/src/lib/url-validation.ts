import { lookup as dnsLookup } from "node:dns/promises";

import { Agent } from "undici";
import { z } from "zod";

// Strict canonical dotted-decimal IPv4 (each octet 1-3 decimal digits).
const CANONICAL_IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

// "Numeric-shaped" hostnames: digits, dots, and `x`/`X` only. A real DNS name
// has at least one alpha character that isn't `x`. If a hostname is numeric-
// shaped but doesn't match canonical IPv4, the OS resolver may still interpret
// it as an IP via legacy formats (octal `0177.0.0.1`, hex `0x7f.0.0.1`,
// 32-bit integer `2130706433`, 2- or 3-segment forms `127.1` / `127.0.1`).
// Any of those would let an admin bypass the SSRF guard, so fail closed.
const NUMERIC_SHAPED = /^[0-9.xX]+$/;

export function isPrivateOrReservedHost(hostname: string): boolean {
  const host =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;

  const ipv4Match = CANONICAL_IPV4.exec(host);
  if (ipv4Match) {
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

  // Numeric-shaped but not canonical IPv4 → unusual format the resolver may
  // still treat as an IP. Block it.
  if (NUMERIC_SHAPED.test(host)) {
    return true;
  }

  const lower = host.toLowerCase();
  if (lower === "::" || lower === "::1") return true;  // IPv6 loopback / unspecified
  // fc00::/7 unique-local (fc** and fd**) and fe80::/10 link-local (fe8*, fe9*, fea*, feb*)
  if (/^f[cd]/i.test(lower) || /^fe[89ab]/i.test(lower)) return true;

  return false;
}

/**
 * Custom DNS lookup hook for the SSRF-safe undici agent. Resolves all A/AAAA
 * records for the host, refuses if ANY of them is private/reserved (defends
 * against multi-record `(public, private)` rebinding tricks), then pins the
 * connection to the first validated address.
 *
 * The error message intentionally does not include the resolved IP — surfacing
 * an internal IP in error responses would itself be a small information leak
 * to the attacker who provoked the failure.
 */
type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string,
  family: number
) => void;

export async function ssrfSafeLookup(
  hostname: string,
  _options: unknown,
  callback: LookupCallback
): Promise<void> {
  try {
    const records = await dnsLookup(hostname, { all: true, verbatim: true });
    if (records.length === 0) {
      callback(new Error("DNS lookup returned no records.") as NodeJS.ErrnoException, "", 0);
      return;
    }
    for (const record of records) {
      if (isPrivateOrReservedHost(record.address)) {
        callback(
          new Error(
            "Refusing to connect: hostname resolves to a private or reserved address."
          ) as NodeJS.ErrnoException,
          "",
          0
        );
        return;
      }
    }
    const first = records[0]!;
    callback(null, first.address, first.family);
  } catch (err) {
    callback(err as NodeJS.ErrnoException, "", 0);
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
 * Trade-off: the override breaks undici's default Happy Eyeballs (which would
 * try every resolved address on connect failure). For the rare admin-driven
 * fetches this guard protects, that is an acceptable availability cost.
 */
export const ssrfSafeAgent = new Agent({
  connect: {
    lookup: ssrfSafeLookup as never
  }
});

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
  );
