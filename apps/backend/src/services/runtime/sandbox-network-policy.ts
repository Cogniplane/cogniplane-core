// The network policy of a sandbox (VULN-13). One tenant setting, the approved
// hosts, becomes one value that decides every call to the sandbox provider:
// the options at creation, the check of what the provider reports, and the hash
// that is saved next to the sandbox id. The policy of a sandbox is fixed when
// it is created. A sandbox that does not match the policy as it is later is
// replaced, never changed: nothing in the backend can change the network of a
// running sandbox.
//
// What E2B enforces, from the SDK types and checked live on 2026-10-14:
// - Default deny. `denyOut: ["0.0.0.0/0"]` blocks all IPv4 egress, DNS
//   included. The guest has only a link-local IPv6 address and no IPv6 route,
//   and the API refuses an IPv6 CIDR, so there is nothing to deny there.
// - Approved hosts go in `allowOut`, and the API then requires the deny-all
//   entry. A host entry matches the TLS server name on port 443 and the HTTP
//   Host header on port 80, and nothing else. `example.com` does not match
//   `www.example.com`. `*.example.com` matches `www.example.com` and not
//   `example.com`.
// - A web request is judged by the name it states, and is sent to that name.
//   A request that states an approved name but is aimed at another address
//   still reaches the named host (SNI `example.com` aimed at 8.8.8.8 returned
//   the page of example.com under its valid certificate), so aiming at an
//   address does not reach a server of the caller's choice. A request that
//   states a name that is not approved is dropped. The provider does not
//   compare the TLS server name with the Host header inside the connection;
//   the host decides (Cloudflare answered 403 to a mismatch).
// - While any host is approved, all traffic to 8.8.8.8 is allowed. That is the
//   resolver of the guest. DNS lookups then work for every name, and so does
//   TLS to it (Google DNS over HTTPS). Data can leave through the names in
//   those lookups. Deny-all has no such path: the same requests are dropped.
// - `169.254.169.254` answers inside the guest whatever the policy says. It is
//   the Firecracker metadata service, which the provider runs and which holds
//   the sandbox id, template id, a log collector address and a token hash.
// - `allowPublicTraffic: false` makes the sandbox URLs (`<port>-<id>.e2b.app`)
//   need a traffic access token. The application does not use them. A sandbox
//   that was created without it (every sandbox from before this policy; the
//   provider then reports no network configuration) does not match the policy
//   and is replaced.
// - The SDK can replace the egress rules of a running sandbox, and the backend
//   never does: a request that is sent cannot be recalled, and two replicas
//   that each hold an old request can undo each other's change. A fixed network
//   leaves nothing to race. The only way to a different network is a new sandbox.
// - `Sandbox.getInfo` reports the network as it is now. A record that an
//   earlier call saved is not proof of it, so each turn reads it again. For a
//   sandbox that this code created, the report has `allowOut`, `denyOut` and
//   `allowPublicTraffic`, and nothing else (checked live on 2026-10-14). The SDK
//   type can also carry `rules`, `egressProxy`, `maskRequestHost` and
//   `httpsPorts`, and the object that the SDK builds has those names with the
//   value `undefined`. That is the only value that means "not set". This code
//   never asks for them, so a report that has any other value for one of them
//   (null, false, an empty text, list or object included) does not match the
//   policy. The check reads values and not key names, or it would refuse every
//   sandbox.

import { createHash } from "node:crypto";

import { parseSandboxEgressDomain } from "@cogniplane/shared-types/sandbox-egress";

import type { E2bNetworkConfig, E2bSandboxInfoLike } from "./e2b-sandbox.js";

/** All IPv4 destinations. E2B exports this as `ALL_TRAFFIC`. */
export const SANDBOX_DENY_ALL_EGRESS = "0.0.0.0/0";

/** Raise it when the mapping to provider options changes, so that saved hashes stop matching. */
const POLICY_VERSION = 1;

export type SandboxNetworkMode = "deny-all" | "allowlist";

export type SandboxNetworkPolicy = {
  /** `deny-all` when no host is approved. */
  readonly mode: SandboxNetworkMode;
  /** Checked, sorted, without duplicates. */
  readonly allowedDomains: readonly string[];
  /** Digest of everything that the provider receives. Saved next to the sandbox id. */
  readonly hash: string;
};

export function sandboxNetworkMode(allowedDomains: readonly string[]): SandboxNetworkMode {
  return allowedDomains.length === 0 ? "deny-all" : "allowlist";
}

/**
 * Builds the policy for a list of approved hosts. The admin API has checked
 * each entry already. This checks again, because the provider accepts any
 * text, including `*`, and a value that was edited in the database would
 * otherwise reach it. An entry that fails is dropped, which approves less.
 * `onRejected` gets the dropped entries.
 */
export function resolveSandboxNetworkPolicy(
  approvedDomains: readonly string[] | null | undefined,
  onRejected?: (rejected: string[]) => void
): SandboxNetworkPolicy {
  const accepted = new Set<string>();
  const rejected: string[] = [];
  for (const entry of approvedDomains ?? []) {
    const result = parseSandboxEgressDomain(entry);
    if (result.ok) accepted.add(result.value.domain);
    else rejected.push(String(entry));
  }
  if (rejected.length > 0) onRejected?.(rejected);
  const allowedDomains = [...accepted].sort();
  const hash = createHash("sha256")
    .update(JSON.stringify({ version: POLICY_VERSION, ...egressRules(allowedDomains), allowPublicTraffic: false }))
    .digest("hex");
  return { mode: sandboxNetworkMode(allowedDomains), allowedDomains, hash };
}

function egressRules(allowedDomains: readonly string[]): { denyOut: string[]; allowOut?: string[] } {
  return {
    denyOut: [SANDBOX_DENY_ALL_EGRESS],
    ...(allowedDomains.length > 0 ? { allowOut: [...allowedDomains] } : {})
  };
}

/** The `network` option of `Sandbox.create`. */
export function toE2bCreateNetwork(policy: SandboxNetworkPolicy): E2bNetworkConfig {
  return { ...egressRules(policy.allowedDomains), allowPublicTraffic: false };
}

export type NetworkCheck = { ok: true } | { ok: false; reason: string };

/** The only network settings that this code sends. */
const REQUESTED_NETWORK_SETTINGS: ReadonlySet<string> = new Set(["allowOut", "denyOut", "allowPublicTraffic"]);

/**
 * Compares what the provider reports with the policy: the egress rules and the
 * public-URL setting. The same check applies to a sandbox that was just created
 * and to one that is read at the start of a turn. A sandbox that fails it is not
 * used: the provider can ignore an option, an admin can change the list of hosts
 * after the sandbox was created, and a sandbox from before the policy has public
 * URLs and open egress. An unchecked policy is only a label. A record that an
 * earlier call saved is never a substitute for this.
 *
 * Extra entries in `denyOut` do not fail it: with the deny-all entry present they
 * add nothing. An approved host that is missing or extra does. So does any other
 * setting that the provider reports, whatever its value, except `undefined`: this
 * code requests only `allowOut`, `denyOut` and `allowPublicTraffic`, and e2b@2.53.1
 * builds the report with every optional name present and the value `undefined`
 * (checked live). Nothing else stands for "not set": `null`, `false`, an empty
 * text, an empty list and an empty object are settings that were not requested. A `rules` entry can add headers
 * to requests, and an `egressProxy` sends the egress through a server of another
 * party. A provider that reports such a setting did not apply the policy as it was sent.
 */
export function checkReportedNetwork(info: E2bSandboxInfoLike, policy: SandboxNetworkPolicy): NetworkCheck {
  const network = info.network;
  if (!network) {
    return { ok: false, reason: "the provider reports no network configuration, so the sandbox URLs are public and egress is open" };
  }
  // Only a sandbox that was created with allowPublicTraffic: false has closed
  // URLs. An absent value means the provider's default, which is public.
  if (network.allowPublicTraffic !== false) {
    return { ok: false, reason: "the provider keeps the sandbox URLs public" };
  }
  if (!network.denyOut?.includes(SANDBOX_DENY_ALL_EGRESS)) {
    return { ok: false, reason: "the provider does not deny all egress" };
  }
  const reported = [...new Set(network.allowOut ?? [])].sort();
  if (reported.length !== policy.allowedDomains.length || reported.some((entry, i) => entry !== policy.allowedDomains[i])) {
    return { ok: false, reason: "the provider reports a different list of approved hosts" };
  }
  for (const [name, value] of Object.entries(network)) {
    if (!REQUESTED_NETWORK_SETTINGS.has(name) && value !== undefined) {
      return { ok: false, reason: `the provider reports a network setting that was not requested (${name})` };
    }
  }
  return { ok: true };
}

/** Thrown when the provider reports a policy other than the one that was sent. */
export class SandboxNetworkPolicyError extends Error {
  constructor(reason: string) {
    super(`The sandbox network policy was not applied: ${reason}.`);
    this.name = "SandboxNetworkPolicyError";
  }
}

/**
 * Thrown when the network policy of a sandbox cannot be confirmed: the provider
 * or the tenant settings cannot be read in time, or the session is no longer
 * owned. Nothing ran in the sandbox, and it was not killed: its files are still
 * there, and the next call asks again.
 */
export class SandboxNetworkPolicyUnconfirmedError extends Error {
  constructor(reason: string, options?: { cause?: unknown }) {
    super(
      `The sandbox network policy could not be confirmed with the provider (${reason}). ` +
        "No command was run. Try again.",
      options
    );
    this.name = "SandboxNetworkPolicyUnconfirmedError";
  }
}

/**
 * Thrown when an operation, or the creation of a sandbox, stops because the turn
 * that asked for it is over: the turn ended, was cancelled, or was replaced by the
 * next one. Nothing was run for it. It is a kind of unconfirmed error, so code
 * that fails closed on the base class does so for this one too.
 */
export class SandboxTurnEndedError extends SandboxNetworkPolicyUnconfirmedError {
  constructor() {
    super("the turn that asked for this operation is over");
    this.name = "SandboxTurnEndedError";
  }
}
