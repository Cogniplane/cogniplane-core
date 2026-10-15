// The public suffix test that both host policies share: the sandbox egress
// list (`sandbox-egress.ts`) and the widget CSP sources (`csp-sources.ts`). A
// wildcard approves every name below its parent, so the parent decides how
// much one approval covers. Keep this rule in one place. It needs the public
// suffix list, so only modules that can load `tldts` import it.

import { parse as parseDomain } from "tldts";

// The private section of the list is included, so github.io and vercel.app
// are suffixes like com and co.uk.
const LIST_OPTIONS = { allowPrivateDomains: true } as const;
// A child label that no list rule names, to test the rules below a parent.
const PROBE_LABEL = "psl-wildcard-probe";

/**
 * True when `*.host` may be approved: `host` is a name that one party
 * registers, and a name one label below it is not a public suffix.
 *
 * The first test rejects a suffix such as `com`, `co.uk` or `github.io`. The
 * second test rejects a parent whose children are suffixes, as in the list rule
 * `*.kobe.jp`: every name below kobe.jp is its own registry, so `*.kobe.jp`
 * would cover unrelated parties. A list exception, such as `city.kobe.jp`,
 * makes a name registrable again, and the second test passes for it.
 *
 * `host` must already be a valid lower-case host name.
 */
export function isRegistrableWildcardParent(host: string): boolean {
  if (parseDomain(host, LIST_OPTIONS).domain === null) return false;
  return parseDomain(`${PROBE_LABEL}.${host}`, LIST_OPTIONS).domain !== null;
}
