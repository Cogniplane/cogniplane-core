// Names and limits for the content security policy sources that an MCP app
// widget may use. This file has no runtime dependencies, so schema files and
// the browser can import it. The parser itself is in `csp-sources.ts`, which
// needs a public suffix list and is exported as a separate entry point.

/** The four source lists that a widget resource can declare. */
export const MCP_APP_CSP_DIRECTIVES = [
  "resourceDomains",
  "connectDomains",
  "frameDomains",
  "baseUriDomains"
] as const;
export type McpAppCspDirective = (typeof MCP_APP_CSP_DIRECTIVES)[number];

/** Plain words for an administrator. Each key is a source list, not a header name. */
export const MCP_APP_CSP_DIRECTIVE_LABELS: Record<McpAppCspDirective, string> = {
  resourceDomains: "Scripts, styles, images, fonts and media",
  connectDomains: "Network requests",
  frameDomains: "Embedded frames",
  baseUriDomains: "Base URL"
};

/** A longer source is never valid. */
export const CSP_SOURCE_MAX_LENGTH = 300;
/** The most sources that one source list can contribute. Later ones are ignored. */
export const CSP_MAX_SOURCES_PER_DIRECTIVE = 25;

export const CSP_SOURCE_ERROR_CODES = [
  "not_a_string",
  "empty",
  "too_long",
  "forbidden_characters",
  "scheme_not_allowed",
  "userinfo",
  "path",
  "ip_address",
  "bad_port",
  "bad_wildcard",
  "bad_host",
  "special_use_host",
  "public_suffix_wildcard"
] as const;
export type CspSourceErrorCode = (typeof CSP_SOURCE_ERROR_CODES)[number];

export const CSP_SOURCE_ERROR_MESSAGES: Record<CspSourceErrorCode, string> = {
  not_a_string: "A source must be text.",
  empty: "Enter a source.",
  too_long: "A source can have at most 300 characters.",
  forbidden_characters: "A source cannot have spaces, quotes, semicolons, commas, or non-ASCII characters. Use the xn-- form for international names.",
  scheme_not_allowed: "Use https://. Only network requests can use wss://.",
  userinfo: "A source cannot have a user name or password.",
  path: "A source is a host name only. Remove the path, query, or fragment.",
  ip_address: "IP addresses are not allowed. Use a host name.",
  bad_port: "The port must be a number from 1 to 65535.",
  bad_wildcard: "A wildcard can only be the first label, as in *.example.com.",
  bad_host: "Enter a full host name, such as cdn.example.com.",
  special_use_host: "Local and reserved names, such as localhost, .local and .internal, are not allowed.",
  public_suffix_wildcard: "A wildcard cannot cover a public suffix, such as *.com or *.co.uk. Name your own domain."
};

/** One source in one source list. `source` is in normal form. */
export type CspDeclarationEntry = { directive: McpAppCspDirective; source: string };
