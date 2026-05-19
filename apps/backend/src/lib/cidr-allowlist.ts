import { BlockList, isIP, isIPv4, isIPv6 } from "node:net";

/**
 * Parses a comma-separated CIDR string into a Node `BlockList`. Single IPs
 * (no `/`) are accepted and treated as `/32` (IPv4) or `/128` (IPv6).
 *
 * Returns `null` when the input is empty, which the caller should treat as
 * "no allowlist configured — admit everything". Invalid entries throw at
 * construction time so misconfiguration fails fast at boot rather than
 * silently disabling the guard.
 *
 * Loopback (127.0.0.1 and ::1) is always admitted when an allowlist is
 * configured. Same-process callers (e.g. the backend's local Claude SDK
 * routing through /llm/anthropic) reach the proxy over loopback, and the
 * OS guarantees loopback peers cannot be spoofed from off-host. Without
 * this carve-out, enabling E2B_EGRESS_CIDRS would silently break the
 * local/regional fallback for the in-process Claude SDK.
 */
export function parseCidrAllowlist(raw: string): BlockList | null {
  const entries = raw
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  if (entries.length === 0) return null;

  const list = new BlockList();
  for (const entry of entries) {
    const [addr, prefixRaw] = entry.split("/", 2);
    if (!addr) throw new Error(`Invalid CIDR entry: ${entry}`);
    const family = isIPv4(addr) ? "ipv4" : isIPv6(addr) ? "ipv6" : null;
    if (!family) throw new Error(`Invalid IP in CIDR entry: ${entry}`);
    if (prefixRaw === undefined) {
      list.addAddress(addr, family);
      continue;
    }
    const prefix = Number(prefixRaw);
    if (!Number.isInteger(prefix) || prefix < 0) {
      throw new Error(`Invalid prefix in CIDR entry: ${entry}`);
    }
    if (family === "ipv4" && prefix > 32) {
      throw new Error(`IPv4 prefix out of range: ${entry}`);
    }
    if (family === "ipv6" && prefix > 128) {
      throw new Error(`IPv6 prefix out of range: ${entry}`);
    }
    list.addSubnet(addr, prefix, family);
  }
  list.addAddress("127.0.0.1", "ipv4");
  list.addAddress("::1", "ipv6");
  return list;
}

/**
 * Check membership tolerantly: returns `false` for non-IP inputs (Fastify
 * may report e.g. unix-socket peers as the empty string in test harnesses).
 * Strips an `::ffff:` IPv4-mapped-IPv6 prefix so a v4 address coming in over
 * a dual-stack socket still matches a v4 subnet.
 */
export function cidrAllowlistAllows(list: BlockList, address: string): boolean {
  const stripped = address.startsWith("::ffff:") ? address.slice(7) : address;
  const family = isIP(stripped);
  if (family === 0) return false;
  return list.check(stripped, family === 4 ? "ipv4" : "ipv6");
}
