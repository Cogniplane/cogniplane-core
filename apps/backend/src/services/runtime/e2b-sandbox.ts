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
  kill: () => Promise<void>;
};

export async function loadE2bSandboxClass(): Promise<{
  create: (
    templateId: string,
    options: {
      apiKey: string;
      envs?: Record<string, string>;
      timeoutMs: number;
      metadata?: Record<string, string>;
    }
  ) => Promise<E2bSandboxLike>;
}> {
  const mod = await import("e2b");
  return mod.Sandbox as {
    create: (
      templateId: string,
      options: {
        apiKey: string;
        envs?: Record<string, string>;
        timeoutMs: number;
        metadata?: Record<string, string>;
      }
    ) => Promise<E2bSandboxLike>;
  };
}
