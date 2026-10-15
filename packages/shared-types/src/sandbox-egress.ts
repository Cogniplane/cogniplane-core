// One policy for the hosts that agent-run code in a tenant's sandbox may reach
// (VULN-13). The backend uses it to check what an administrator approves and,
// again, before it sends the list to the sandbox provider. The admin page uses
// it to check input before it sends it.
//
// This entry point needs a public suffix list, so it is a separate export
// (`@cogniplane/shared-types/sandbox-egress`). The main entry point does not
// load it.
//
// The provider does not check these entries. E2B accepted `*`, `*.com`, a URL,
// an IP address, a port and mixed case when we sent them, and it applies a
// bare `*` to every web request. This file is the only check.
//
// This is a check of the text of an entry. The provider enforces the entry by
// the host name that a request states (the TLS server name and the HTTP Host
// header) and sends the request to that name. See
// `apps/backend/src/services/runtime/sandbox-network-policy.ts` for what the
// provider does and does not enforce.

import { parse as parseDomain } from "tldts";
import { z } from "zod";

import { isRegistrableWildcardParent } from "./public-suffix.js";

/** The most hosts one tenant can approve. The provider accepted 200 in a live test. */
export const SANDBOX_EGRESS_DOMAINS_MAX = 25;
/** The provider documents 128 characters as its limit for a rule domain. */
export const SANDBOX_EGRESS_DOMAIN_MAX_LENGTH = 128;
/** A request that carries more entries than this is refused before any entry is checked. */
const SANDBOX_EGRESS_REQUEST_MAX = SANDBOX_EGRESS_DOMAINS_MAX * 4;

export type SandboxEgressErrorCode =
  | "not_a_string"
  | "empty"
  | "too_long"
  | "whitespace"
  | "scheme"
  | "userinfo"
  | "path"
  | "port_or_ip"
  | "bad_wildcard"
  | "uppercase"
  | "bad_characters"
  | "bad_label"
  | "ip_address"
  | "single_label"
  | "special_use"
  | "unknown_suffix"
  | "public_suffix_wildcard";

/** Each message completes a sentence that starts with the entry, such as `"*.com" ...`. */
export const SANDBOX_EGRESS_ERROR_MESSAGES: Record<SandboxEgressErrorCode, string> = {
  not_a_string: "must be text.",
  empty: "is empty.",
  too_long: `is longer than ${SANDBOX_EGRESS_DOMAIN_MAX_LENGTH} characters.`,
  whitespace: "must not contain spaces.",
  scheme: "must be a host name only. Remove the scheme, such as https://.",
  userinfo: "must not contain a user name or password.",
  path: "must be a host name only. Remove the path, query or fragment.",
  port_or_ip: "must not contain a port or an IP address. Approve host names only.",
  bad_wildcard: "can use * only as a first label, such as *.example.com.",
  uppercase: "must be lower case.",
  bad_characters:
    "can contain only the letters a to z, digits, hyphens and dots. Write international names in xn-- form.",
  bad_label:
    "has an empty label, a label longer than 63 characters, or a label that starts or ends with a hyphen.",
  ip_address: "is an IP address. Approve host names only.",
  single_label: "needs at least two labels, such as example.com.",
  special_use: "is a name that is not a public internet host.",
  unknown_suffix: "ends in a name that is not a public internet suffix.",
  public_suffix_wildcard:
    "would approve every host under a public suffix. Use a name that one party registers, such as *.example.com."
};

export type ParsedSandboxEgressDomain = {
  /** The text to store and to send to the provider. It is the input, which must already be canonical. */
  domain: string;
  /** True for `*.host`. The provider matches one or more labels before `host`, and not `host` itself. */
  wildcard: boolean;
  /** The host name without a leading `*.`. */
  host: string;
};

export type SandboxEgressDomainResult =
  | { ok: true; value: ParsedSandboxEgressDomain }
  | { ok: false; code: SandboxEgressErrorCode; message: string };

// A last label of these never names a public host. Most are also absent from
// the public suffix list, but `onion` and `arpa` are in it.
const SPECIAL_USE_LABELS: ReadonlySet<string> = new Set([
  "localhost", "local", "internal", "localdomain", "test", "invalid", "example",
  "onion", "alt", "arpa", "lan", "home", "corp", "intranet", "private"
]);
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// A host with a number as its last label is an IPv4 address in the URL
// standard: 127.1, 2130706433 and 0x7f.1 all qualify.
const NUMERIC_LAST_LABEL = /^(?:[0-9]+|0x[0-9a-f]*)$/;

function fail(code: SandboxEgressErrorCode): SandboxEgressDomainResult {
  return { ok: false, code, message: SANDBOX_EGRESS_ERROR_MESSAGES[code] };
}

/**
 * Checks one approved host. An entry is a host name, or `*.` and a host name.
 * It must already be canonical: lower case, with no spaces. Anything else
 * fails, so what an administrator sees is what the provider enforces.
 */
export function parseSandboxEgressDomain(value: unknown): SandboxEgressDomainResult {
  if (typeof value !== "string") return fail("not_a_string");
  if (value.length === 0) return fail("empty");
  if (value.length > SANDBOX_EGRESS_DOMAIN_MAX_LENGTH) return fail("too_long");
  if (/\s/.test(value)) return fail("whitespace");
  if (value.includes("://")) return fail("scheme");
  if (value.includes("@")) return fail("userinfo");
  if (/[/?#\\]/.test(value)) return fail("path");
  if (/[:[\]]/.test(value)) return fail("port_or_ip");

  const wildcard = value.startsWith("*.");
  const host = wildcard ? value.slice(2) : value;
  if (host.includes("*")) return fail("bad_wildcard");
  if (/[^a-z0-9.-]/.test(host)) {
    // Say "lower case" when lower casing is the whole problem.
    return /^[A-Za-z0-9.-]+$/.test(host) ? fail("uppercase") : fail("bad_characters");
  }

  const labels = host.split(".");
  if (labels.some((label) => !HOST_LABEL.test(label))) return fail("bad_label");
  const top = labels[labels.length - 1];
  if (NUMERIC_LAST_LABEL.test(top)) return fail("ip_address");
  // *.com has one label after the *. and approves every .com host.
  if (labels.length < 2) return fail(wildcard ? "public_suffix_wildcard" : "single_label");
  if (SPECIAL_USE_LABELS.has(top)) return fail("special_use");

  const parsed = parseDomain(host, { allowPrivateDomains: true });
  // A suffix that no list rule matched is an invented one, such as .internal.
  if (!parsed.isIcann && !parsed.isPrivate) return fail("unknown_suffix");
  // The parent of a wildcard must be a name that one party registers, and a name
  // below it must not be a suffix (see `public-suffix.ts`). The list includes
  // its private section, so *.github.io and *.vercel.app fail too, and so does
  // *.kobe.jp. An exact host names one host, not a whole suffix, so it is not
  // checked.
  if (wildcard && !isRegistrableWildcardParent(host)) return fail("public_suffix_wildcard");

  return { ok: true, value: { domain: value, wildcard, host } };
}

/** Removes duplicates and sorts. Two lists with the same hosts then compare equal. */
export function normalizeSandboxEgressDomains(domains: readonly string[]): string[] {
  return [...new Set(domains)].sort();
}

export type SandboxEgressListIssue = {
  /** Position in the input list, or null for a problem with the list itself. */
  index: number | null;
  value: string | null;
  message: string;
};

export type SandboxEgressListResult =
  | { ok: true; domains: string[] }
  | { ok: false; issues: SandboxEgressListIssue[] };

/** Checks a whole list. On success, the domains are normalized. */
export function validateSandboxEgressDomains(value: unknown): SandboxEgressListResult {
  if (!Array.isArray(value)) {
    return { ok: false, issues: [{ index: null, value: null, message: "The approved hosts must be a list." }] };
  }
  if (value.length > SANDBOX_EGRESS_REQUEST_MAX) {
    return { ok: false, issues: [{ index: null, value: null, message: `The list has more than ${SANDBOX_EGRESS_REQUEST_MAX} entries.` }] };
  }
  const issues: SandboxEgressListIssue[] = [];
  const accepted: string[] = [];
  value.forEach((entry, index) => {
    const result = parseSandboxEgressDomain(entry);
    if (result.ok) accepted.push(result.value.domain);
    else issues.push({ index, value: typeof entry === "string" ? entry : null, message: `${describe(entry)} ${result.message}` });
  });
  const domains = normalizeSandboxEgressDomains(accepted);
  if (issues.length === 0 && domains.length > SANDBOX_EGRESS_DOMAINS_MAX) {
    issues.push({
      index: null,
      value: null,
      message: `Approve at most ${SANDBOX_EGRESS_DOMAINS_MAX} hosts. This list has ${domains.length}.`
    });
  }
  return issues.length === 0 ? { ok: true, domains } : { ok: false, issues };
}

function describe(entry: unknown): string {
  return typeof entry === "string" ? JSON.stringify(entry.length > 40 ? `${entry.slice(0, 40)}...` : entry) : "An entry";
}

/**
 * The request contract for the approved hosts of a tenant. It rejects the
 * whole list when one entry fails, and names each failing entry. The output is
 * the list as sent: the store sorts and removes duplicates.
 */
export const SandboxEgressDomainsSchema = z.array(z.string()).superRefine((list, context) => {
  const result = validateSandboxEgressDomains(list);
  if (result.ok) return;
  for (const issue of result.issues) {
    context.addIssue({
      code: "custom",
      message: issue.message,
      ...(issue.index === null ? {} : { path: [issue.index] })
    });
  }
});
