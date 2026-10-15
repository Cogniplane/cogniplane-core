// One policy for the content security policy sources of an MCP app widget.
// The backend uses it to check what an administrator approves and to limit what
// a widget declares. The admin page uses it to check input before it sends it.
//
// This entry point needs a public suffix list, so it is a separate export
// (`@cogniplane/shared-types/csp-sources`). The main entry point does not load
// it. The sandbox page cannot load a module. It keeps a small copy of the
// parsing and matching rules without the list, and it checks the same vectors
// (`csp-source-vectors.ts`) as this file does.
//
// This is a check of the text of a source. It says nothing about the address
// that a host name resolves to. A name can resolve to a private address.

import { isRegistrableWildcardParent } from "./public-suffix.js";
import {
  CSP_MAX_SOURCES_PER_DIRECTIVE,
  CSP_SOURCE_ERROR_MESSAGES,
  CSP_SOURCE_MAX_LENGTH,
  MCP_APP_CSP_DIRECTIVES,
  type CspDeclarationEntry,
  type CspSourceErrorCode,
  type McpAppCspDirective
} from "./mcp-app-csp.js";

export {
  CSP_SOURCE_ERROR_MESSAGES,
  MCP_APP_CSP_DIRECTIVES,
  type CspDeclarationEntry,
  type CspSourceErrorCode,
  type McpAppCspDirective
};

export type ParsedCspSource = {
  scheme: "https" | "wss";
  /** True for `*.host`. The wildcard matches one or more labels before `host`. */
  wildcard: boolean;
  host: string;
  /** Null is the default port of the scheme. */
  port: number | null;
  /** The text to put in a policy: lower case, and no default port. */
  normalized: string;
};

export type CspSourceResult =
  | { ok: true; source: ParsedCspSource }
  | { ok: false; reason: CspSourceErrorCode };

// A top-level label of these never names a public host.
const SPECIAL_USE_LABELS: ReadonlySet<string> = new Set([
  "localhost", "local", "internal", "localdomain", "test", "invalid", "example",
  "onion", "alt", "arpa", "lan", "home", "corp", "intranet", "private"
]);
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// The URL standard reads a host as an IPv4 address when its last label is a
// number, in decimal or in hexadecimal. 127.1, 2130706433 and 0x7f.1 all qualify.
const NUMERIC_LAST_LABEL = /^(?:[0-9]+|0x[0-9a-f]*)$/;

function fail(reason: CspSourceErrorCode): CspSourceResult {
  return { ok: false, reason };
}

/**
 * Parses one source for one source list. A source is a scheme, a host, and an
 * optional port. The host can start with `*.`. Anything else fails.
 */
export function parseCspSource(value: unknown, directive: McpAppCspDirective): CspSourceResult {
  if (typeof value !== "string") return fail("not_a_string");
  if (value.length === 0) return fail("empty");
  if (value.length > CSP_SOURCE_MAX_LENGTH) return fail("too_long");
  // Whitespace and controls end a source. Quotes, semicolons and commas let
  // text start a new source or a new directive. The rest are not host characters.
  if (/[^\x21-\x7e]|[;,'"<>\\`^|{}%]/.test(value)) return fail("forbidden_characters");

  const match = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(value);
  if (!match) return fail("scheme_not_allowed");
  const scheme = match[1].toLowerCase();
  if (scheme !== "https" && scheme !== "wss") return fail("scheme_not_allowed");
  // Only network requests use a WebSocket.
  if (scheme === "wss" && directive !== "connectDomains") return fail("scheme_not_allowed");
  const authority = match[2];
  if (authority.includes("@")) return fail("userinfo");
  if (/[/?#]/.test(authority)) return fail("path");
  if (authority.startsWith("[")) return fail("ip_address");

  let hostText = authority;
  let port: number | null = null;
  const colon = authority.lastIndexOf(":");
  if (colon >= 0) {
    hostText = authority.slice(0, colon);
    // A second colon is an IPv6 address with no brackets.
    if (hostText.includes(":")) return fail("ip_address");
    const portText = authority.slice(colon + 1);
    if (!/^[1-9][0-9]{0,4}$/.test(portText) || Number(portText) > 65535) return fail("bad_port");
    port = Number(portText) === 443 ? null : Number(portText);
  }

  let host = hostText.toLowerCase();
  const wildcard = host.startsWith("*.");
  if (wildcard) host = host.slice(2);
  if (host.includes("*")) return fail("bad_wildcard");

  const labels = host.split(".");
  if (host.length > 253 || labels.some((label) => !HOST_LABEL.test(label))) return fail("bad_host");
  const top = labels[labels.length - 1];
  if (NUMERIC_LAST_LABEL.test(top)) return fail("ip_address");
  if (SPECIAL_USE_LABELS.has(top)) return fail("special_use_host");
  if (labels.length < 2) return fail(wildcard ? "public_suffix_wildcard" : "bad_host");
  // The parent of a wildcard must be a name that one party registers, and a name
  // below it must not be a suffix. The list includes the private section, so
  // *.github.io and *.vercel.app fail, and so does *.kobe.jp. An exact host is
  // not checked: it names one host, not a whole suffix.
  if (wildcard && !isRegistrableWildcardParent(host)) return fail("public_suffix_wildcard");

  const normalized = `${scheme}://${wildcard ? "*." : ""}${host}${port === null ? "" : `:${port}`}`;
  return { ok: true, source: { scheme, wildcard, host, port, normalized } };
}

/** True when `approved` allows everything that `declared` asks for. */
export function cspSourceCovers(approved: ParsedCspSource, declared: ParsedCspSource): boolean {
  if (approved.scheme !== declared.scheme || approved.port !== declared.port) return false;
  if (!approved.wildcard) return !declared.wildcard && declared.host === approved.host;
  // `*.example.com` covers a name below example.com, and a wildcard below it.
  // It does not cover example.com itself.
  return declared.host === approved.host
    ? declared.wildcard
    : declared.host.endsWith(`.${approved.host}`);
}

function listOf(declared: unknown, directive: McpAppCspDirective): unknown[] | null {
  if (!declared || typeof declared !== "object" || Array.isArray(declared)) return null;
  const list = (declared as Record<string, unknown>)[directive];
  return Array.isArray(list) ? list.slice(0, CSP_MAX_SOURCES_PER_DIRECTIVE) : null;
}

/**
 * Every well-formed source in a widget's declaration, in normal form, without
 * duplicates. These are the sources that an administrator can approve.
 */
export function parseCspDeclarations(declared: unknown): CspDeclarationEntry[] {
  const entries: CspDeclarationEntry[] = [];
  for (const directive of MCP_APP_CSP_DIRECTIVES) {
    const seen = new Set<string>();
    for (const value of listOf(declared, directive) ?? []) {
      const result = parseCspSource(value, directive);
      if (result.ok && !seen.has(result.source.normalized)) {
        seen.add(result.source.normalized);
        entries.push({ directive, source: result.source.normalized });
      }
    }
  }
  return entries;
}

/**
 * What a widget may use: its own declaration, limited to the approved sources
 * of the same source list. A list the widget did not declare stays absent.
 * An approved source that is not valid approves nothing.
 */
export function intersectCspDeclarations(
  declared: unknown,
  approved: readonly CspDeclarationEntry[]
): Partial<Record<McpAppCspDirective, string[]>> {
  const csp: Partial<Record<McpAppCspDirective, string[]>> = {};
  for (const directive of MCP_APP_CSP_DIRECTIVES) {
    const values = listOf(declared, directive);
    if (!values) continue;
    const approvedSources: ParsedCspSource[] = [];
    for (const entry of approved) {
      if (entry.directive !== directive) continue;
      const result = parseCspSource(entry.source, directive);
      if (result.ok) approvedSources.push(result.source);
    }
    const allowed: string[] = [];
    for (const value of values) {
      const result = parseCspSource(value, directive);
      if (result.ok && !allowed.includes(result.source.normalized) &&
          approvedSources.some((source) => cspSourceCovers(source, result.source))) {
        allowed.push(result.source.normalized);
      }
    }
    csp[directive] = allowed;
  }
  return csp;
}

/** The approved sources in the shape of a declaration. */
export function groupCspEntries(entries: readonly CspDeclarationEntry[]): Record<McpAppCspDirective, string[]> {
  const grouped: Record<McpAppCspDirective, string[]> = {
    resourceDomains: [], connectDomains: [], frameDomains: [], baseUriDomains: []
  };
  for (const entry of entries) grouped[entry.directive].push(entry.source);
  return grouped;
}

/** The message for a failed source, for the administrator. */
export function describeCspSourceError(reason: CspSourceErrorCode): string {
  return CSP_SOURCE_ERROR_MESSAGES[reason];
}
