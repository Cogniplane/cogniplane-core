// Thin structural interface over the E2B SDK's Sandbox, shared by every
// consumer that talks to an E2B sandbox (today: the Deep Agents execution
// backend). Extracted from the retired Codex e2b-runtime-process (bead
// quap.2) so the sandbox surface survives the runtime it was written for.

/** Session workspaces are rooted here inside every sandbox template. */
export const E2B_WORKSPACE_BASE = "/home/user/workspace";

export type E2bCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
};

/**
 * Sandbox network configuration, as the E2B SDK sends it at creation and reads it
 * back (e2b@2.53 `SandboxNetworkOpts`, `SandboxNetworkInfo`). Semantics that this
 * code relies on, from the SDK types and checked live:
 * - Egress is open unless `denyOut` says otherwise.
 * - `allowOut` accepts domains, IPs and CIDR blocks and wins over `denyOut`.
 *   The API refuses domains in `allowOut` unless `denyOut` holds `0.0.0.0/0`.
 * - `denyOut` takes CIDR blocks and IPs, not domains. IPv6 CIDRs (`::/0`) are
 *   refused.
 * - Nothing validates the entries. Callers must send only checked hosts.
 */
export type E2bNetworkConfig = {
  allowOut?: string[];
  denyOut?: string[];
  /** false: sandbox URLs need the sandbox traffic access token. Create-only. */
  allowPublicTraffic?: boolean;
};

/**
 * Limits on one control-plane request, as the SDK takes them (`requestTimeoutMs`
 * and `signal` of `SandboxApiOpts`). The SDK default timeout is 60 s. The signal
 * also stops the SDK's own retries of a 429, 502 or 503, which it makes by default
 * (checked against e2b@2.53.1, see e2b-sandbox.test.ts).
 */
export type E2bRequestLimits = {
  requestTimeoutMs?: number;
  signal?: AbortSignal;
};

/**
 * The network of a sandbox as `Sandbox.getInfo` reports it (e2b@2.53 `SandboxNetworkInfo`). The
 * SDK type also has `rules` (transforms of requests, such as added headers), `egressProxy` (a
 * SOCKS5 proxy that the egress is tunneled through), `maskRequestHost` and `httpsPorts`. This
 * code asks for none of them, and for a sandbox that it created the provider reports only
 * `allowOut`, `denyOut` and `allowPublicTraffic` (checked live on 2026-10-14). The SDK object
 * has the other names too, with the value `undefined`, so the check reads values and not key
 * names. The names are kept open on purpose: the check rejects any setting that was not
 * requested and has a value other than `undefined`.
 */
export type E2bReportedNetwork = E2bNetworkConfig & Record<string, unknown>;

/** The part of `Sandbox.getInfo` that the network check reads. */
export type E2bSandboxInfoLike = {
  network?: E2bReportedNetwork;
};

// Structural subset of the E2B SDK's Sandbox class (e2b@^2.19), narrowed to
// exactly what the Deep Agents execution backend (the sole consumer) touches.
// Kept in sync manually — verify against the SDK when upgrading e2b.
export type E2bSandboxLike = {
  sandboxId: string;
  files: {
    write: (files: Array<{ path: string; data: string | ArrayBuffer }>) => Promise<void>;
    read: (path: string, opts: { format: "bytes" }) => Promise<Uint8Array>;
    getInfo: (path: string) => Promise<{ size: number }>;
  };
  commands: {
    run: (
      command: string,
      options?: {
        cwd?: string;
        envs?: Record<string, string>;
        timeoutMs?: number;
      }
    ) => Promise<E2bCommandResult>;
  };
  /**
   * Resets the sandbox's lifetime cap to `timeoutMs` from NOW (the SDK
   * documents it as extending or reducing the timeout set at creation or by
   * the previous call — it is not additive). This is what turns the cap from
   * an absolute deadline into an idle timeout.
   */
  setTimeout: (timeoutMs: number) => Promise<void>;
  // The network of a sandbox is fixed when it is created. The SDK has a call that
  // changes the egress rules of a running sandbox, and it is left out of this
  // interface on purpose: code that cannot call it cannot race it, and a sandbox
  // that does not match its policy is replaced instead (see
  // deep-agents-e2b-backend.ts). Do not add it back.
  kill: (limits?: E2bRequestLimits) => Promise<void>;
};

/** The options of `Sandbox.create` that the backend sets (e2b@2.53 `SandboxOpts`). */
export type E2bCreateOptions = {
  apiKey: string;
  envs?: Record<string, string>;
  timeoutMs: number;
  metadata?: Record<string, string>;
  network?: E2bNetworkConfig;
  /** How often the SDK sends the request again after a 429, 502 or 503, or a failed connection. Its default is 3. */
  retries?: number;
};

/**
 * The options of every `Sandbox.create` call of the backend. The tests send these same
 * options to the real SDK, so a change here is checked against what the SDK does with it.
 */
export function toE2bCreateOptions(input: {
  apiKey: string;
  timeoutMs: number;
  metadata: Record<string, string>;
  network: E2bNetworkConfig;
}): E2bCreateOptions {
  return {
    apiKey: input.apiKey,
    envs: {},
    timeoutMs: input.timeoutMs,
    metadata: input.metadata,
    network: input.network,
    // Zero. This request creates a resource. The SDK sends it again after a 503, and a
    // gateway can answer 503 after the provider made the sandbox. The second request would
    // make a second sandbox, and nothing would know the first one or kill it. A creation that
    // fails is tried again by the next call, which reads the policy again.
    retries: 0
  };
}

/** The static side of the E2B SDK's Sandbox class that the backend uses. */
export type E2bSandboxClassLike = {
  create: (templateId: string, options: E2bCreateOptions) => Promise<E2bSandboxLike>;
  connect: (sandboxId: string, options: { apiKey: string; timeoutMs: number }) => Promise<E2bSandboxLike>;
  getInfo: (sandboxId: string, options: { apiKey: string } & E2bRequestLimits) => Promise<E2bSandboxInfoLike>;
};

export async function loadE2bSandboxClass(): Promise<E2bSandboxClassLike> {
  const mod = await import("e2b");
  return mod.Sandbox as unknown as E2bSandboxClassLike;
}
