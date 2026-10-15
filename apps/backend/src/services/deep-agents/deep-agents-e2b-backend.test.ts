import { createSilentLogger } from "../../test-helpers/silent-logger.js";
import { BaseSandbox } from "deepagents";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  E2bDeepAgentsSandbox,
  isSandboxGoneError,
  type E2bDeepAgentsSandboxOptions
} from "./deep-agents-e2b-backend.js";
import type { E2bNetworkConfig, E2bRequestLimits, loadE2bSandboxClass } from "../runtime/e2b-sandbox.js";
import {
  resolveSandboxNetworkPolicy,
  SandboxNetworkPolicyError,
  SandboxNetworkPolicyUnconfirmedError,
  SandboxTurnEndedError
} from "../runtime/sandbox-network-policy.js";

const fakeLog = createSilentLogger();

/** What E2B reports for a sandbox that this code created under deny-all. */
const DENY_ALL_NETWORK = { denyOut: ["0.0.0.0/0"], allowPublicTraffic: false };

/**
 * What the backend sends with every request that it makes to the provider in a
 * network check: a time limit and the signal that cancels the request.
 */
const REQUEST_LIMITS = { requestTimeoutMs: expect.any(Number), signal: expect.any(AbortSignal) };

/**
 * Every fake sandbox of the test in progress. The network of a sandbox is fixed
 * when it is created, so at the end of every test in this file none of them may
 * have been asked to change it (see the guard below).
 */
const fakesInTest: Array<{ sandbox: { updateNetwork: ReturnType<typeof vi.fn> } }> = [];

afterEach(() => {
  try {
    for (const fake of fakesInTest) expect(fake.sandbox.updateNetwork).not.toHaveBeenCalled();
  } finally {
    fakesInTest.length = 0;
  }
});

type RunCall = { command: string; options?: Record<string, unknown> };

function makeFakeSandbox(overrides: {
  runResult?: (command: string) => unknown | Promise<unknown>;
} = {}) {
  const runCalls: RunCall[] = [];
  const files = new Map<string, Uint8Array>();
  const killed = vi.fn(async (_limits?: E2bRequestLimits) => {});
  const setTimeoutCalls: number[] = [];
  const sandbox = {
    sandboxId: "sbx-123",
    /** What the provider reports for this sandbox. The provider stand-in sets it at creation. */
    reportedNetwork: undefined as E2bNetworkConfig | undefined,
    // The real SDK has this call, and the backend must never make it: the interface that the backend
    // uses does not have it. The guard after every test fails if it was called anyway.
    updateNetwork: vi.fn(() => { throw new Error("the backend must never change the network of a running sandbox"); }),
    setTimeout: vi.fn(async (timeoutMs: number) => {
      setTimeoutCalls.push(timeoutMs);
    }),
    files: {
      write: async (entries: Array<{ path: string; data: string | ArrayBuffer }>) => {
        for (const entry of entries) {
          files.set(
            entry.path,
            typeof entry.data === "string"
              ? new TextEncoder().encode(entry.data)
              : new Uint8Array(entry.data)
          );
        }
      },
      read: async (path: string) => {
        const stored = files.get(path);
        if (!stored) throw new Error(`file not found: ${path}`);
        return stored;
      },
      getInfo: async (path: string) => {
        const stored = files.get(path);
        if (!stored) throw new Error(`file not found: ${path}`);
        return { size: stored.byteLength };
      }
    },
    commands: {
      run: async (command: string, options?: Record<string, unknown>) => {
        runCalls.push({ command, options });
        if (overrides.runResult) return overrides.runResult(command);
        return { stdout: `ran:${command}`, stderr: "", exitCode: 0 };
      },
      sendStdin: async () => {},
      list: async () => []
    },
    kill: killed
  };
  const fake = { sandbox, runCalls, files, killed, setTimeoutCalls };
  fakesInTest.push(fake);
  return fake;
}

type FakeSandbox = ReturnType<typeof makeFakeSandbox>["sandbox"];

/**
 * Stand-in for the provider's static Sandbox class. It remembers each sandbox
 * it hands out, and reports back the network that the sandbox was created with,
 * as the real `Sandbox.getInfo` does.
 */
function makeProvider(inner: {
  create?: (templateId: string, options: { network?: E2bNetworkConfig }) => Promise<unknown>;
  connect?: (sandboxId: string, options: unknown) => Promise<unknown>;
}) {
  const known = new Map<string, FakeSandbox>();
  const remember = (sandbox: unknown) => {
    const fake = sandbox as FakeSandbox;
    known.set(fake.sandboxId, fake);
    return fake;
  };
  const create = vi.fn(async (templateId: string, options: { network?: E2bNetworkConfig }) => {
    const sandbox = remember(await (inner.create ?? (async () => { throw new Error("unexpected create"); }))(templateId, options));
    sandbox.reportedNetwork = options.network;
    return sandbox;
  });
  const connect = vi.fn(async (sandboxId: string, options: unknown) =>
    remember(await (inner.connect ?? (async () => { throw new Error("unexpected connect"); }))(sandboxId, options)));
  /** What the provider reports now for a sandbox that it handed out. */
  const report = (sandboxId: string) => ({ network: known.get(sandboxId)?.reportedNetwork });
  const getInfo = vi.fn(async (sandboxId: string, _options?: { apiKey: string } & E2bRequestLimits) => report(sandboxId));
  return {
    create, connect, getInfo, known, report,
    loader: (async () => ({ create, connect, getInfo })) as unknown as typeof loadE2bSandboxClass
  };
}

function makeBackend(input: {
  fake: ReturnType<typeof makeFakeSandbox>;
  createSpy?: ReturnType<typeof vi.fn>;
  loader?: typeof loadE2bSandboxClass;
  options?: Partial<E2bDeepAgentsSandboxOptions>;
  /** Set to false for a backend on which no turn has begun, as it is before the first one. */
  beginTurn?: boolean;
}) {
  const create =
    input.createSpy ??
    vi.fn(async () => input.fake.sandbox);
  const provider = makeProvider({ create: create as unknown as Parameters<typeof makeProvider>[0]["create"] });
  const backend = new E2bDeepAgentsSandbox({
    apiKey: "e2b-key",
    templateId: "tpl-slim",
    sandboxTimeoutMs: 60_000,
    executeTimeoutMs: 5_000,
    workspacePath: "/home/user/workspace/sess-1",
    sessionId: "sess-1",
    runtimeId: "deepagents-rt",
    logger: fakeLog,
    // The tenant settings, as the sandbox reads them: no host approved.
    resolveNetworkPolicy: async () => resolveSandboxNetworkPolicy([]),
    loadSandboxClass: input.loader ?? provider.loader,
    networkConfirmTimeoutMs: 20_000,
    networkRequestTimeoutMs: 5_000,
    // Four reads of the network report, with no waiting between them.
    networkRetryBackoffMs: [0, 0, 0],
    ...input.options
  });
  // Nothing runs outside a turn. The first turn begins here, as the adapter begins it before any use.
  // The end function belongs to this turn: a test that ends it calls it.
  const endTurn = input.beginTurn === false ? () => {} : backend.beginTurn();
  return { backend, create, provider, endTurn };
}

describe("E2bDeepAgentsSandbox", () => {
  it("reconnects to a prior replica's workspace", async () => {
    const fake = makeFakeSandbox();
    let saved: { sandboxId: string; networkPolicyHash: string | null } | null = null;
    const create = vi.fn(async () => fake.sandbox);
    const connect = vi.fn(async (id: string) => {
      expect(id).toBe(fake.sandbox.sandboxId);
      return fake.sandbox;
    });
    const loader = makeProvider({ create, connect }).loader;
    const sandboxBinding = {
      load: async () => saved,
      save: async (previousId: string | null, id: string, networkPolicyHash: string) => {
        expect(saved?.sandboxId ?? null).toBe(previousId);
        saved = { sandboxId: id, networkPolicyHash };
      }
    };
    const first = makeBackend({ fake, loader, options: { sandboxBinding } }).backend;
    await first.writeFileBytes("notes.txt", new TextEncoder().encode("kept"));
    await first.kill();
    expect(fake.killed).not.toHaveBeenCalled();
    const second = makeBackend({ fake, loader, options: { sandboxBinding } }).backend;
    expect(new TextDecoder().decode(await second.readFileBytes("notes.txt"))).toBe("kept");
    expect(create).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("reconnects when another replica replaced the saved sandbox", async () => {
    const firstSandbox = makeFakeSandbox();
    const replacement = makeFakeSandbox();
    replacement.sandbox.sandboxId = "sbx-456";
    const policy = resolveSandboxNetworkPolicy([]);
    firstSandbox.sandbox.reportedNetwork = DENY_ALL_NETWORK;
    replacement.sandbox.reportedNetwork = DENY_ALL_NETWORK;
    let savedId: string | null = firstSandbox.sandbox.sandboxId;
    const connect = vi.fn(async (id: string) => id === replacement.sandbox.sandboxId
      ? replacement.sandbox : firstSandbox.sandbox);
    const loader = makeProvider({ connect }).loader;
    const backend = makeBackend({ fake: firstSandbox, loader, options: {
      sandboxBinding: {
        load: async () => savedId ? { sandboxId: savedId, networkPolicyHash: policy.hash } : null,
        save: async () => { throw new Error("unexpected create"); }
      }
    } }).backend;
    await backend.execute("true");
    savedId = replacement.sandbox.sandboxId;
    await replacement.sandbox.files.write([{
      path: "/home/user/workspace/sess-1/notes.txt", data: "new copy"
    }]);
    expect(new TextDecoder().decode(await backend.readFileBytes("notes.txt"))).toBe("new copy");
    expect(connect.mock.calls.map(call => call[0])).toEqual(["sbx-123", "sbx-456"]);
  });

  it("replaces a saved sandbox only when E2B reports it gone", async () => {
    const fake = makeFakeSandbox();
    let savedId: string | null = "expired-sandbox";
    const connect = vi.fn(async () => {
      const error = new Error("sandbox is gone");
      error.name = "SandboxNotFoundError";
      throw error;
    });
    const create = vi.fn(async () => fake.sandbox);
    const onSandboxRecreated = vi.fn();
    const loader = makeProvider({ create, connect }).loader;
    const backend = makeBackend({ fake, loader, options: {
      onSandboxRecreated,
      sandboxBinding: {
        load: async () => savedId ? { sandboxId: savedId, networkPolicyHash: null } : null,
        save: async (previousId, id) => {
          expect(previousId).toBe("expired-sandbox");
          savedId = id;
        }
      }
    } }).backend;
    await backend.execute("true");
    expect(onSandboxRecreated).toHaveBeenCalledWith({ previousSandboxId: "expired-sandbox", reason: "expired" });
    expect(savedId).toBe("sbx-123");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("creates the sandbox lazily and only once", async () => {
    const fake = makeFakeSandbox();
    const create = vi.fn(async (_templateId: string) => fake.sandbox);
    const { backend } = makeBackend({ fake, createSpy: create });

    expect(backend.isCreated).toBe(false);
    expect(backend.id).toBe("deepagents-rt");

    await backend.execute("echo one");
    await backend.execute("echo two");

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0]).toBe("tpl-slim");
    expect(backend.isCreated).toBe(true);
    expect(backend.id).toBe("sbx-123");
    // The two commands run in order after the one-time workspace prep. The prep
    // command's exact shell (mkdir) is an implementation detail, not the contract
    // — the load-bearing part is that both commands ran, in order, after prep.
    expect(fake.runCalls.map((c) => c.command).slice(1)).toEqual(["echo one", "echo two"]);
  });

  it("retries sandbox creation after a failed first attempt", async () => {
    const fake = makeFakeSandbox();
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error("e2b capacity"))
      .mockResolvedValue(fake.sandbox);
    const { backend } = makeBackend({ fake, createSpy: create });

    await expect(backend.execute("echo x")).rejects.toThrow("e2b capacity");
    const result = await backend.execute("echo x");
    expect(result.exitCode).toBe(0);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("kills the created sandbox when the workspace mkdir fails, then retries clean", async () => {
    // R3: Sandbox.create() succeeds but the post-create mkdir throws. The
    // created (billable) sandbox must be killed before the memo clears — else
    // it leaks until E2B's sandboxTimeoutMs — and the next call retries fresh.
    let firstMkdir = true;
    const failingMkdir = makeFakeSandbox({
      runResult: (command) => {
        if (command.includes("mkdir -p") && firstMkdir) {
          firstMkdir = false;
          throw new Error("mkdir timed out");
        }
        return { stdout: `ran:${command}`, stderr: "", exitCode: 0 };
      }
    });
    const freshSandbox = makeFakeSandbox();
    freshSandbox.sandbox.sandboxId = "sbx-456";
    const create = vi
      .fn()
      .mockResolvedValueOnce(failingMkdir.sandbox)
      .mockResolvedValue(freshSandbox.sandbox);
    const { backend } = makeBackend({ fake: failingMkdir, createSpy: create });

    await expect(backend.execute("echo x")).rejects.toThrow("mkdir timed out");
    // The leaked-sandbox fix: the created sandbox was torn down.
    expect(failingMkdir.killed).toHaveBeenCalledTimes(1);

    // Memo cleared → the next call creates a fresh sandbox and succeeds.
    const result = await backend.execute("echo x");
    expect(result.exitCode).toBe(0);
    expect(create).toHaveBeenCalledTimes(2);
    expect(freshSandbox.killed).not.toHaveBeenCalled();
  });

  it("does NOT replay execute() when the sandbox drops mid-command (F9: no double-execution)", async () => {
    // execute() is non-idempotent: replaying it could run a side-effecting
    // command twice. On a sandbox-gone error the backend must NOT re-run the
    // command — it returns a structured 'sandbox lost' result and drops the memo
    // so the NEXT execute() lands on a fresh sandbox.
    const gone = Object.assign(new Error("sandbox sbx-123 was not found"), {
      name: "SandboxNotFoundError"
    });
    const deadSandbox = makeFakeSandbox({
      runResult: (command) => {
        if (command.includes("mkdir -p")) return { stdout: "", stderr: "", exitCode: 0 };
        throw gone;
      }
    });
    const freshSandbox = makeFakeSandbox();
    freshSandbox.sandbox.sandboxId = "sbx-456";
    const create = vi
      .fn()
      .mockResolvedValueOnce(deadSandbox.sandbox)
      .mockResolvedValue(freshSandbox.sandbox);
    const { backend } = makeBackend({ fake: deadSandbox, createSpy: create });

    const result = await backend.execute("curl -X POST https://api.example.com/deploy");

    // Structured 'not re-run' result, not a throw and not a replay.
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("was NOT re-run");
    // The command was never sent to a fresh sandbox.
    expect(freshSandbox.runCalls.map((c) => c.command)).not.toContain(
      "curl -X POST https://api.example.com/deploy"
    );
    // But the poisoned memo is dropped: the NEXT execute() creates a fresh sandbox.
    const next = await backend.execute("echo ok");
    expect(create).toHaveBeenCalledTimes(2);
    expect(backend.id).toBe("sbx-456");
    expect(next).toEqual({ output: "ran:echo ok", exitCode: 0, truncated: false });
  });

  it("recreates the sandbox and retries an IDEMPOTENT op when it has gone away mid-session", async () => {
    // downloadFiles is safe to replay: the backend must drop the memo, create a
    // fresh sandbox, and re-run the read against it.
    const gone = Object.assign(new Error("sandbox sbx-123 was not found"), {
      name: "SandboxNotFoundError"
    });
    let firstRead = true;
    const deadSandbox = makeFakeSandbox();
    deadSandbox.sandbox.files.read = vi.fn(async () => {
      if (firstRead) {
        firstRead = false;
        throw gone;
      }
      return new Uint8Array([1, 2, 3]);
    });
    const freshSandbox = makeFakeSandbox();
    freshSandbox.sandbox.sandboxId = "sbx-456";
    freshSandbox.sandbox.files.read = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const create = vi
      .fn()
      .mockResolvedValueOnce(deadSandbox.sandbox)
      .mockResolvedValue(freshSandbox.sandbox);
    const { backend } = makeBackend({ fake: deadSandbox, createSpy: create });

    const [res] = await backend.downloadFiles(["/data.bin"]);

    expect(res!.error).toBeNull();
    expect(res!.content).toEqual(new Uint8Array([1, 2, 3]));
    expect(create).toHaveBeenCalledTimes(2);
    expect(backend.id).toBe("sbx-456");
  });

  it("rethrows a sandbox-gone upload error so withSandbox recreates and re-writes the whole batch", async () => {
    // uploadFiles backs artifact write-back + workspace sync. A mid-upload
    // sandbox expiry must ESCAPE the per-file catch (rethrown) so withSandbox
    // recreates and re-runs the whole batch — NOT collapse to a per-file
    // permission_denied that silently loses the write. Retrying the full batch
    // is safe (file writes are idempotent).
    const gone = Object.assign(new Error("sandbox sbx-123 was not found"), {
      name: "SandboxNotFoundError"
    });
    const deadSandbox = makeFakeSandbox();
    let firstWrite = true;
    deadSandbox.sandbox.files.write = vi.fn(async () => {
      if (firstWrite) {
        firstWrite = false;
        throw gone;
      }
    });
    const freshSandbox = makeFakeSandbox();
    freshSandbox.sandbox.sandboxId = "sbx-456";
    const create = vi
      .fn()
      .mockResolvedValueOnce(deadSandbox.sandbox)
      .mockResolvedValue(freshSandbox.sandbox);
    const { backend } = makeBackend({ fake: deadSandbox, createSpy: create });

    const results = await backend.uploadFiles([
      ["/a.txt", new Uint8Array([1])],
      ["/b.txt", new Uint8Array([2])]
    ]);

    // The batch was re-written against the fresh sandbox — every file succeeded,
    // none reported as a per-file error.
    expect(results).toEqual([
      { path: "/a.txt", error: null },
      { path: "/b.txt", error: null }
    ]);
    expect(create).toHaveBeenCalledTimes(2);
    expect(backend.id).toBe("sbx-456");
    expect(freshSandbox.files.has("/home/user/workspace/sess-1/a.txt")).toBe(true);
    expect(freshSandbox.files.has("/home/user/workspace/sess-1/b.txt")).toBe(true);
  });

  it("does not recreate the sandbox on a plain file-not-found", async () => {
    // A missing file is not a dead sandbox — downloadFiles must surface the
    // structured error without dropping the memo or recreating.
    const fake = makeFakeSandbox();
    const create = vi.fn(async () => fake.sandbox);
    const { backend } = makeBackend({ fake, createSpy: create });

    const [res] = await backend.downloadFiles(["/missing.txt"]);
    expect(res!.error).toBe("file_not_found");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("recreates on a sandbox-gone error recognized only by its MESSAGE (name stripped)", async () => {
    // isSandboxGoneError has TWO branches: the constructor-name match
    // (name === "SandboxNotFoundError") and a message-regex fallback for
    // wrapped/re-thrown variants where the SDK's error type — and thus its
    // `name` — has been lost. Every other sandbox-gone test constructs the
    // error WITH name: "SandboxNotFoundError", so the name branch always wins
    // and the message fallback is never exercised. This drives the fallback:
    // a PLAIN Error (name === "Error") whose message matches the regex must
    // still be treated as sandbox-gone → drop the memo, recreate, and retry
    // the idempotent read against the fresh sandbox.
    const wrappedGone = new Error("Sandbox sbx-123 not found");
    expect(wrappedGone.name).toBe("Error"); // guard: the name branch cannot fire

    let firstRead = true;
    const deadSandbox = makeFakeSandbox();
    deadSandbox.sandbox.files.read = vi.fn(async () => {
      if (firstRead) {
        firstRead = false;
        throw wrappedGone;
      }
      return new Uint8Array([9, 9, 9]);
    });
    const freshSandbox = makeFakeSandbox();
    freshSandbox.sandbox.sandboxId = "sbx-456";
    freshSandbox.sandbox.files.read = vi.fn(async () => new Uint8Array([9, 9, 9]));
    const create = vi
      .fn()
      .mockResolvedValueOnce(deadSandbox.sandbox)
      .mockResolvedValue(freshSandbox.sandbox);
    const { backend } = makeBackend({ fake: deadSandbox, createSpy: create });

    const [res] = await backend.downloadFiles(["/data.bin"]);

    // Recovered via the message fallback, not the name branch.
    expect(res!.error).toBeNull();
    expect(res!.content).toEqual(new Uint8Array([9, 9, 9]));
    expect(create).toHaveBeenCalledTimes(2);
    expect(backend.id).toBe("sbx-456");
  });

  it("isSandboxGoneError: recognizes gone-sandbox messages and rejects a plain file miss", () => {
    // SDK-bump guard, calling the REAL predicate (not a mirror) so the pinned
    // strings track the production regex. These are the message shapes the
    // recovery path relies on when the SDK error's name has been stripped.
    expect(isSandboxGoneError(new Error("Sandbox sbx-123 not found"))).toBe(true);
    expect(isSandboxGoneError(new Error("sandbox sbx-1 no longer running"))).toBe(true);
    expect(isSandboxGoneError(new Error("Sandbox does not exist"))).toBe(true);
    // The constructor-name branch still wins regardless of message.
    const named = new Error("totally unrelated text");
    named.name = "SandboxNotFoundError";
    expect(isSandboxGoneError(named)).toBe(true);
    // A file-level miss is NOT a dead sandbox — must not trigger recreate.
    const fileMiss = new Error("File /x not found");
    fileMiss.name = "FileNotFoundError";
    expect(isSandboxGoneError(fileMiss)).toBe(false);
    // Non-Error input is safe.
    expect(isSandboxGoneError("Sandbox not found")).toBe(false);
  });

  it("runs commands in the workspace cwd with the per-execute timeout", async () => {
    const fake = makeFakeSandbox();
    const { backend } = makeBackend({ fake });
    const result = await backend.execute("python analyze.py");
    expect(result).toEqual({ output: "ran:python analyze.py", exitCode: 0, truncated: false });
    const call = fake.runCalls.at(-1)!;
    expect(call.options).toMatchObject({
      cwd: "/home/user/workspace/sess-1",
      timeoutMs: 5_000
    });
  });

  it("recovers structured results from non-zero-exit throws", async () => {
    const fake = makeFakeSandbox({
      runResult: (command) => {
        if (command.startsWith("mkdir")) return { stdout: "", stderr: "", exitCode: 0 };
        const err = new Error("exit status 1") as Error & {
          exitCode: number;
          stdout: string;
          stderr: string;
        };
        err.exitCode = 1;
        err.stdout = "partial";
        err.stderr = "boom";
        throw err;
      }
    });
    const { backend } = makeBackend({ fake });
    const result = await backend.execute("false");
    expect(result).toEqual({ output: "partial\nboom", exitCode: 1, truncated: false });
  });

  it("maps per-command timeouts to a synthetic 124 exit", async () => {
    const fake = makeFakeSandbox({
      runResult: (command) => {
        if (command.startsWith("mkdir")) return { stdout: "", stderr: "", exitCode: 0 };
        throw new Error("Command execution timeout: exceeded 5000ms");
      }
    });
    const { backend } = makeBackend({ fake });
    const result = await backend.execute("sleep 999");
    expect(result.exitCode).toBe(124);
    expect(result.output).toContain("timed out");
  });

  it("truncates oversized combined output", async () => {
    const fake = makeFakeSandbox({
      runResult: (command) => {
        if (command.startsWith("mkdir")) return { stdout: "", stderr: "", exitCode: 0 };
        return { stdout: "x".repeat(70_000), stderr: "", exitCode: 0 };
      }
    });
    const { backend } = makeBackend({ fake });
    const result = await backend.execute("cat big.txt");
    expect(result.truncated).toBe(true);
    expect(result.output).toHaveLength(64_000);
  });

  it("confines agent paths to the workspace on upload/download", async () => {
    const fake = makeFakeSandbox();
    const { backend } = makeBackend({ fake });

    const uploads = await backend.uploadFiles([
      ["/report.md", new TextEncoder().encode("hello")],
      ["../../etc/passwd", new TextEncoder().encode("nope")]
    ]);
    expect(uploads).toEqual([
      { path: "/report.md", error: null },
      { path: "../../etc/passwd", error: "invalid_path" }
    ]);
    expect(fake.files.has("/home/user/workspace/sess-1/report.md")).toBe(true);

    const downloads = await backend.downloadFiles(["/report.md", "/missing.txt"]);
    expect(downloads[0]).toMatchObject({ path: "/report.md", error: null });
    expect(new TextDecoder().decode(downloads[0]!.content!)).toBe("hello");
    expect(downloads[1]).toMatchObject({ path: "/missing.txt", content: null, error: "file_not_found" });
  });

  it("remaps ls paths so '/' means the workspace root", async () => {
    const fake = makeFakeSandbox({
      runResult: () => ({ stdout: "", stderr: "", exitCode: 0 })
    });
    const { backend } = makeBackend({ fake });
    await backend.ls("/");
    const lsCall = fake.runCalls.at(-1)!;
    expect(lsCall.command).toContain("/home/user/workspace/sess-1");
    expect(lsCall.command).not.toMatch(/find '?\/ /);
  });

  it("remaps read paths so text reads round-trip with workspace writes", async () => {
    const fake = makeFakeSandbox({
      runResult: () => ({ stdout: "     1\tevicted tool result", stderr: "", exitCode: 0 })
    });
    const { backend } = makeBackend({ fake });

    // The fs middleware evicts large tool results to "/large_tool_results/<id>.txt"
    // via write() (remapped into the workspace) and then instructs the model to
    // read_file that exact path — the text-read shell command must target the
    // remapped workspace path, not the sandbox root.
    const result = await backend.read("/large_tool_results/abc.txt");
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("evicted tool result");
    const readCall = fake.runCalls.at(-1)!;
    expect(readCall.command).toContain("/home/user/workspace/sess-1/large_tool_results/abc.txt");
  });

  it("returns a structured error for ls/read/grep/glob paths escaping the workspace", async () => {
    const fake = makeFakeSandbox();
    const { backend } = makeBackend({ fake });

    const escaping = "../../etc";
    expect(await backend.ls(escaping)).toEqual({ error: "Path is outside the session workspace" });
    expect(await backend.read("../../etc/passwd")).toEqual({
      error: "Path is outside the session workspace"
    });
    expect(await backend.grep("root", escaping)).toEqual({
      error: "Path is outside the session workspace"
    });
    expect(await backend.glob("*.conf", escaping)).toEqual({
      error: "Path is outside the session workspace"
    });
    // No shell command may run for an escaping path (only lazy-create mkdir
    // from sandbox creation is allowed).
    expect(fake.runCalls.filter((c) => !c.command.includes("mkdir")).length).toBe(0);
  });

  it("defaults grep/glob to the workspace root, not the sandbox filesystem root", async () => {
    // The model commonly calls grep/glob with no directory. That default must
    // root the search at the session workspace — NOT at "/" — else grep/glob
    // would leak the whole sandbox filesystem into results (a confinement break).
    const fake = makeFakeSandbox({
      runResult: () => ({ stdout: "", stderr: "", exitCode: 0 })
    });
    const { backend } = makeBackend({ fake });

    await backend.grep("needle");
    const grepCall = fake.runCalls.at(-1)!;
    expect(grepCall.command).toContain("/home/user/workspace/sess-1");
    // The search must NOT be rooted at bare "/".
    expect(grepCall.command).not.toMatch(/ '?\/'? *$/);
    expect(grepCall.command).not.toMatch(/(rg|grep)[^\n]* '?\/'?(\s|$)/);

    await backend.glob("**/*.ts");
    const globCall = fake.runCalls.at(-1)!;
    expect(globCall.command).toContain("/home/user/workspace/sess-1");
    expect(globCall.command).not.toMatch(/find '?\/'? /);
  });

  it("maps directory and permission failures to distinct upload error codes", async () => {
    const fake = makeFakeSandbox();
    fake.sandbox.files.write = async (entries: Array<{ path: string }>) => {
      const target = entries[0]!.path;
      if (target.includes("dir-target")) throw new Error("EISDIR: illegal operation on a directory");
      if (target.includes("locked")) throw new Error("EACCES: permission denied");
      throw new Error("socket hang up");
    };
    const { backend } = makeBackend({ fake });

    const uploads = await backend.uploadFiles([
      ["/dir-target", new Uint8Array([1])],
      ["/locked.txt", new Uint8Array([2])],
      ["/flaky.txt", new Uint8Array([3])]
    ]);
    // Unknown failures (e.g. transient network) fall back to permission_denied
    // — invalid_path is reserved for path validation so the model doesn't
    // rewrite a correct path.
    expect(uploads.map((u) => u.error)).toEqual([
      "is_directory",
      "permission_denied",
      "permission_denied"
    ]);
  });

  it("exposes byte-level file helpers for the adapter", async () => {
    const fake = makeFakeSandbox();
    const { backend } = makeBackend({ fake });

    const sandboxPath = await backend.writeFileBytes("artifacts/chart.png", new Uint8Array([1, 2, 3]));
    expect(sandboxPath).toBe("/home/user/workspace/sess-1/artifacts/chart.png");
    expect(await backend.statFile("artifacts/chart.png")).toEqual({ sizeBytes: 3 });
    expect(await backend.readFileBytes("artifacts/chart.png")).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("resolves absolute-in-workspace paths to themselves (no re-rooting)", async () => {
    const fake = makeFakeSandbox();
    const { backend } = makeBackend({ fake });

    // A tool echoing a real sandbox path (e.g. write_artifact.filePath from a
    // shell command's output) must hit that exact path — parity with the
    // Codex/Claude adapters — not a doubled "<ws>/home/user/workspace/…".
    const absolute = "/home/user/workspace/sess-1/artifacts/revenue.png";
    const sandboxPath = await backend.writeFileBytes(absolute, new Uint8Array([1]));
    expect(sandboxPath).toBe(absolute);
    expect(await backend.readFileBytes(absolute)).toEqual(new Uint8Array([1]));

    // Workspace-rooted convention still applies to other absolute paths.
    expect(await backend.writeFileBytes("/notes.txt", new Uint8Array([2]))).toBe(
      "/home/user/workspace/sess-1/notes.txt"
    );

    // A workspace-prefixed path that dot-dots into a FOREIGN session
    // normalizes outside this workspace, so it falls back to workspace-rooted
    // handling: confined inside sess-1, never written to sess-2's real path.
    const uploads = await backend.uploadFiles([
      ["/home/user/workspace/sess-1/../sess-2/steal.txt", new Uint8Array([3])]
    ]);
    expect(uploads[0]!.error).toBe(null);
    expect(fake.files.has("/home/user/workspace/sess-2/steal.txt")).toBe(false);
    const written = [...fake.files.keys()].filter((key) => key.includes("steal"));
    expect(written).toEqual(["/home/user/workspace/sess-1/home/user/workspace/sess-2/steal.txt"]);
  });

  it("writes exactly the view's bytes for pooled/offset buffers", async () => {
    // Node pools small Buffers inside a shared 8KB ArrayBuffer; writing
    // `view.buffer` (or Buffer.slice().buffer — a view, not a copy) uploads
    // the whole pool and pads small files with NULs. Model that with an
    // explicit offset view into a larger buffer.
    const pool = new Uint8Array(64).fill(0);
    const csv = new TextEncoder().encode("a,b\n1,2\n");
    pool.set(csv, 10);
    const view = new Uint8Array(pool.buffer, 10, csv.byteLength);

    const fake = makeFakeSandbox();
    const { backend } = makeBackend({ fake });

    await backend.uploadFiles([["/data.csv", view]]);
    expect(await backend.readFileBytes("/data.csv")).toEqual(csv);

    await backend.writeFileBytes("/data2.csv", view);
    expect(await backend.readFileBytes("/data2.csv")).toEqual(csv);
  });

  it("extendTimeout() pushes the lifetime cap back to the full window", async () => {
    // R12: the E2B cap runs from FIRST tool use and is never renewed, so an
    // active session crosses it mid-turn and loses its whole workspace. Called
    // at each turn start, this converts the cap from an absolute deadline into
    // an idle timeout.
    const fake = makeFakeSandbox();
    const { backend } = makeBackend({ fake, options: { sandboxTimeoutMs: 30 * 60_000 } });

    await backend.execute("echo hi");
    await backend.extendTimeout();

    expect(fake.setTimeoutCalls).toEqual([30 * 60_000]);
  });

  it("extendTimeout() does NOT create a sandbox for a session that never used one", async () => {
    // Laziness is load-bearing: chat-only sessions must pay zero sandbox cost,
    // and extending at every turn start would otherwise create one on turn 1.
    const fake = makeFakeSandbox();
    const { backend, create } = makeBackend({ fake });

    await backend.extendTimeout();

    expect(create).not.toHaveBeenCalled();
    expect(backend.isCreated).toBe(false);
    expect(fake.setTimeoutCalls).toEqual([]);
  });

  it("extendTimeout() swallows a failed extension instead of failing the turn", async () => {
    // A sandbox that already expired throws here. The turn must proceed —
    // withSandbox recreates on the next op — rather than dying at turn start.
    const fake = makeFakeSandbox();
    fake.sandbox.setTimeout = vi.fn(async () => {
      throw Object.assign(new Error("sandbox sbx-123 was not found"), {
        name: "SandboxNotFoundError"
      });
    });
    const { backend } = makeBackend({ fake });

    await backend.execute("echo hi");

    await expect(backend.extendTimeout()).resolves.toBeUndefined();
  });

  it("notifies when a gone sandbox is transparently replaced", async () => {
    // The replacement silently discards every agent-written file and every
    // synced artifact; without this the model only meets file_not_found on its
    // own work. The notice must carry the sandbox that was lost.
    const gone = Object.assign(new Error("sandbox sbx-123 was not found"), {
      name: "SandboxNotFoundError"
    });
    let firstRead = true;
    const deadSandbox = makeFakeSandbox();
    deadSandbox.sandbox.files.read = vi.fn(async () => {
      if (firstRead) {
        firstRead = false;
        throw gone;
      }
      return new Uint8Array([1]);
    });
    const freshSandbox = makeFakeSandbox();
    freshSandbox.sandbox.sandboxId = "sbx-456";
    freshSandbox.sandbox.files.read = vi.fn(async () => new Uint8Array([1]));
    const create = vi
      .fn()
      .mockResolvedValueOnce(deadSandbox.sandbox)
      .mockResolvedValue(freshSandbox.sandbox);
    const onSandboxRecreated = vi.fn();
    const { backend } = makeBackend({
      fake: deadSandbox,
      createSpy: create,
      options: { onSandboxRecreated }
    });

    await backend.downloadFiles(["/data.bin"]);

    expect(onSandboxRecreated).toHaveBeenCalledTimes(1);
    expect(onSandboxRecreated).toHaveBeenCalledWith({ previousSandboxId: "sbx-123", reason: "expired" });
  });

  it("notifies on a sandbox replacement even when the command is NOT replayed", async () => {
    // execute() declines to replay (it can't tell "never ran" from "ran but the
    // stream dropped), but the workspace is just as gone — the notice must not
    // be tied to the retry branch.
    const gone = Object.assign(new Error("sandbox sbx-123 was not found"), {
      name: "SandboxNotFoundError"
    });
    const fake = makeFakeSandbox({
      runResult: (command) => {
        if (command.includes("mkdir")) return { stdout: "", stderr: "", exitCode: 0 };
        throw gone;
      }
    });
    const onSandboxRecreated = vi.fn();
    const { backend } = makeBackend({ fake, options: { onSandboxRecreated } });

    const result = await backend.execute("curl -X POST /deploy");

    // execute() surfaces the loss as a structured non-replay result rather than
    // throwing, so the model is told the command may or may not have landed.
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/NOT re-run/);
    expect(onSandboxRecreated).toHaveBeenCalledTimes(1);
  });

  it("a throwing recreation notice never breaks the tool call", async () => {
    const gone = Object.assign(new Error("sandbox sbx-123 was not found"), {
      name: "SandboxNotFoundError"
    });
    let firstRead = true;
    const deadSandbox = makeFakeSandbox();
    deadSandbox.sandbox.files.read = vi.fn(async () => {
      if (firstRead) {
        firstRead = false;
        throw gone;
      }
      return new Uint8Array([7]);
    });
    const freshSandbox = makeFakeSandbox();
    freshSandbox.sandbox.sandboxId = "sbx-456";
    freshSandbox.sandbox.files.read = vi.fn(async () => new Uint8Array([7]));
    const create = vi
      .fn()
      .mockResolvedValueOnce(deadSandbox.sandbox)
      .mockResolvedValue(freshSandbox.sandbox);
    const { backend } = makeBackend({
      fake: deadSandbox,
      createSpy: create,
      options: {
        onSandboxRecreated: () => {
          throw new Error("push failed");
        }
      }
    });

    const [res] = await backend.downloadFiles(["/data.bin"]);

    expect(res!.error).toBeNull();
    expect(res!.content).toEqual(new Uint8Array([7]));
  });

  it("replaces a dead sandbox ONCE when concurrent ops both hit it", async () => {
    // Two in-flight ops against the same expired sandbox both enter the
    // sandbox-gone handler. Without a guard the second discards the first's
    // fresh sandbox, starts a third, fires a duplicate notice, and splits
    // writes across two sandboxes while the memo keeps only one.
    const gone = Object.assign(new Error("sandbox sbx-123 was not found"), {
      name: "SandboxNotFoundError"
    });
    const deadSandbox = makeFakeSandbox();
    // Both reads on the dead sandbox fail; both callers then recover.
    deadSandbox.sandbox.files.read = vi.fn(async () => {
      throw gone;
    });
    const freshSandbox = makeFakeSandbox();
    freshSandbox.sandbox.sandboxId = "sbx-456";
    freshSandbox.sandbox.files.read = vi.fn(async () => new Uint8Array([9]));
    const create = vi
      .fn()
      .mockResolvedValueOnce(deadSandbox.sandbox)
      .mockResolvedValue(freshSandbox.sandbox);
    const onSandboxRecreated = vi.fn();
    const { backend } = makeBackend({
      fake: deadSandbox,
      createSpy: create,
      options: { onSandboxRecreated }
    });

    const [a, b] = await Promise.all([
      backend.downloadFiles(["/a.bin"]),
      backend.downloadFiles(["/b.bin"])
    ]);

    // Both callers get their data from the SAME replacement sandbox.
    expect(a[0]!.content).toEqual(new Uint8Array([9]));
    expect(b[0]!.content).toEqual(new Uint8Array([9]));
    expect(backend.id).toBe("sbx-456");
    // One death, one replacement, one notice — not two of each.
    expect(onSandboxRecreated).toHaveBeenCalledTimes(1);
    expect(onSandboxRecreated).toHaveBeenCalledWith({ previousSandboxId: "sbx-123", reason: "expired" });
    // The dead sandbox plus exactly one replacement.
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("kill() terminates a created sandbox and blocks further use", async () => {
    const fake = makeFakeSandbox();
    const { backend } = makeBackend({ fake });
    await backend.execute("echo warm");

    await backend.kill();
    expect(fake.killed).toHaveBeenCalledTimes(1);
    await expect(backend.execute("echo dead")).rejects.toThrow(/terminated/);

    // Idempotent: a second kill is a no-op.
    await backend.kill();
    expect(fake.killed).toHaveBeenCalledTimes(1);
  });

  it("kill() is a no-op when the sandbox was never created", async () => {
    const fake = makeFakeSandbox();
    const { backend } = makeBackend({ fake });
    await backend.kill();
    expect(fake.killed).not.toHaveBeenCalled();
  });
});


// VULN-13: the network policy of a sandbox is fixed when the sandbox is created.
// Nothing here can change the network of a running sandbox: the fake sandbox has
// a method for it that fails the test that calls it (see the guard at the top of
// the file). A sandbox that does not match the policy is replaced. Every case
// checks what the provider is asked to create and what it reports back, because
// a policy that is only recorded would pass a test that looks at the options alone.
describe("E2bDeepAgentsSandbox network policy", () => {
  const denyAll = resolveSandboxNetworkPolicy([]);
  const approved = resolveSandboxNetworkPolicy(["pypi.org", "*.example.com"]);
  const other = resolveSandboxNetworkPolicy(["files.pythonhosted.org"]);
  const APPROVED_NETWORK = { denyOut: ["0.0.0.0/0"], allowOut: ["*.example.com", "pypi.org"], allowPublicTraffic: false };
  const OTHER_NETWORK = { denyOut: ["0.0.0.0/0"], allowOut: ["files.pythonhosted.org"], allowPublicTraffic: false };

  /** The tenant settings, as the sandbox reads them: what the policy is now, and how often it was asked. */
  function makeSettings(initial: typeof denyAll) {
    const state = { current: initial };
    const resolve = vi.fn(async () => state.current);
    return { state, resolve };
  }

  /**
   * The saved record of the sandbox of a session. `lease.owner` says which replica
   * holds the session lease: the record is read and written only under it, as the
   * real store does.
   */
  function makeBinding(
    initial: { sandboxId: string; networkPolicyHash: string | null } | null,
    lease?: { owner: { current: string }; name: string }
  ) {
    const state = { saved: initial };
    const requireLease = () => {
      if (lease && lease.owner.current !== lease.name) {
        throw Object.assign(new Error("execution_stopped"), { code: "execution_stopped", statusCode: 403 });
      }
    };
    const binding = {
      load: vi.fn(async () => { requireLease(); return state.saved; }),
      save: vi.fn(async (previousId: string | null, sandboxId: string, networkPolicyHash: string) => {
        requireLease();
        expect(previousId).toBe(state.saved?.sandboxId ?? null);
        state.saved = { sandboxId, networkPolicyHash };
      })
    };
    return { state, binding };
  }

  /** A sandbox that exists on the provider, with the network that the provider reports for it. */
  function existing(id: string, network: E2bNetworkConfig | undefined) {
    const fake = makeFakeSandbox();
    fake.sandbox.sandboxId = id;
    fake.sandbox.reportedNetwork = network;
    return fake;
  }

  /**
   * A session whose saved sandbox is `sbx-old`, reported as `live`, and a backend that
   * reconnects to it. The tenant policy is `policy`. A replacement, `sbx-new`, is what the
   * provider creates next.
   */
  function reconnect(input: {
    live: E2bNetworkConfig | undefined;
    policy?: typeof denyAll;
    options?: Partial<E2bDeepAgentsSandboxOptions>;
    lease?: { owner: { current: string }; name: string };
  }) {
    const saved = existing("sbx-old", input.live);
    const replacement = existing("sbx-new", undefined);
    const { binding, state } = makeBinding({ sandboxId: "sbx-old", networkPolicyHash: "recorded-hash" }, input.lease);
    const settings = makeSettings(input.policy ?? denyAll);
    const provider = makeProvider({
      connect: async (id) => (id === replacement.sandbox.sandboxId ? replacement.sandbox : saved.sandbox),
      create: async () => replacement.sandbox
    });
    const onSandboxRecreated = vi.fn();
    const { backend, endTurn } = makeBackend({
      fake: saved,
      loader: provider.loader,
      options: { sandboxBinding: binding, onSandboxRecreated, resolveNetworkPolicy: settings.resolve, ...input.options }
    });
    return { saved, replacement, binding, state, provider, settings, onSandboxRecreated, backend, endTurn };
  }

  const gone = () => Object.assign(new Error("sandbox sbx-old was not found"), { name: "SandboxNotFoundError" });

  /** Every read of the provider's report fails until `heal()`, as with a dropped connection. */
  function breakReads(provider: ReturnType<typeof makeProvider>) {
    let broken = true;
    provider.getInfo.mockImplementation(async (id: string) => {
      if (broken) throw new Error("fetch failed");
      return provider.report(id);
    });
    return { heal: () => { broken = false; } };
  }

  /** What a turn that finds a sandbox that does not match must do, every time. */
  function expectReplaced(r: ReturnType<typeof reconnect>, policy: typeof denyAll, network: E2bNetworkConfig) {
    // The old sandbox is killed, once, and nothing ran in it.
    expect(r.saved.killed).toHaveBeenCalledTimes(1);
    expect(r.saved.runCalls).toEqual([]);
    expect(r.onSandboxRecreated).toHaveBeenCalledTimes(1);
    expect(r.onSandboxRecreated).toHaveBeenCalledWith({ previousSandboxId: "sbx-old", reason: "network_policy" });
    // The new one is created under the policy as it is now, confirmed, and recorded.
    expect(r.provider.create).toHaveBeenCalledTimes(1);
    expect(r.provider.create.mock.calls[0]![1].network).toEqual(network);
    expect(r.binding.save).toHaveBeenCalledWith("sbx-old", "sbx-new", policy.hash);
    expect(r.state.saved).toEqual({ sandboxId: "sbx-new", networkPolicyHash: policy.hash });
    expect(r.replacement.sandbox.reportedNetwork).toEqual(network);
    expect(r.replacement.runCalls.at(-1)?.command).toBe("echo hi");
  }

  // ── A new sandbox ──────────────────────────────────────────────────────────

  it("creates the sandbox with default deny and closed public URLs, and checks it with the provider", async () => {
    const fake = makeFakeSandbox();
    const { binding } = makeBinding(null);
    const { backend, provider } = makeBackend({ fake, options: { sandboxBinding: binding } });

    await backend.execute("echo hi");

    const options = provider.create.mock.calls[0]![1];
    expect(options.network).toEqual(DENY_ALL_NETWORK);
    expect(options.network).not.toHaveProperty("allowOut");
    expect(provider.getInfo).toHaveBeenCalledWith("sbx-123", { apiKey: "e2b-key", ...REQUEST_LIMITS });
    // The hash of the policy that it was created under is saved with the id.
    expect(binding.save).toHaveBeenCalledWith(null, "sbx-123", denyAll.hash);
  });

  it("sends the creation request once: the SDK is told not to send it again", async () => {
    const fake = makeFakeSandbox();
    const { backend, provider } = makeBackend({ fake });

    await backend.execute("echo hi");

    // Exactly what the SDK receives. With the SDK default of 3 retries, a 503 that comes after the
    // provider made the sandbox would make a second sandbox, which nothing knows or kills.
    expect(provider.create.mock.calls[0]![1]).toEqual({
      apiKey: "e2b-key",
      envs: {},
      timeoutMs: 60_000,
      metadata: { provider: "deep-agents", sessionId: "sess-1", runtimeId: "deepagents-rt" },
      network: DENY_ALL_NETWORK,
      retries: 0
    });
  });

  it("sends approved hosts as allowOut next to the deny-all entry", async () => {
    const fake = makeFakeSandbox();
    const { backend, provider } = makeBackend({ fake, options: { resolveNetworkPolicy: async () => approved } });

    await backend.execute("echo hi");

    expect(provider.create.mock.calls[0]![1].network).toEqual(APPROVED_NETWORK);
    // And a sandbox that was created with a host works with that host: the report says so.
    expect(fake.sandbox.reportedNetwork).toEqual(APPROVED_NETWORK);
  });

  it("reads the policy from the tenant settings when it creates, not when it was built", async () => {
    const fake = makeFakeSandbox();
    const settings = makeSettings(denyAll);
    const { backend, provider } = makeBackend({ fake, options: { resolveNetworkPolicy: settings.resolve } });
    // Nothing is read, and nothing is created, until the sandbox is used.
    expect(settings.resolve).not.toHaveBeenCalled();
    // The admin approves hosts before the first command.
    settings.state.current = approved;

    await backend.execute("echo hi");

    expect(settings.resolve).toHaveBeenCalledTimes(1);
    expect(provider.create.mock.calls[0]![1].network).toEqual(APPROVED_NETWORK);
  });

  it("kills a sandbox whose network the provider does not confirm, and runs no command in it", async () => {
    const fake = makeFakeSandbox();
    const { binding } = makeBinding(null);
    const provider = makeProvider({ create: async () => fake.sandbox });
    // The provider ignored the option: it reports no network configuration.
    provider.getInfo.mockResolvedValue({ network: undefined });
    const { backend } = makeBackend({ fake, loader: provider.loader, options: { sandboxBinding: binding } });

    await expect(backend.execute("echo secret")).rejects.toBeInstanceOf(SandboxNetworkPolicyError);

    expect(fake.killed).toHaveBeenCalledTimes(1);
    // Not even the command that prepares the workspace ran.
    expect(fake.runCalls).toEqual([]);
    expect(binding.save).not.toHaveBeenCalled();
    expect(backend.id).toBe("deepagents-rt");
  });

  it.each([
    ["the deny-all entry is missing", { allowOut: [], allowPublicTraffic: false }],
    ["the approved hosts differ", { denyOut: ["0.0.0.0/0"], allowOut: ["evil.example"], allowPublicTraffic: false }],
    ["the sandbox URLs are still public", { denyOut: ["0.0.0.0/0"], allowPublicTraffic: true }],
    // This code never asks for these. Rules can add headers to requests, and a proxy takes the egress.
    ["it reports request rules that were not requested", {
      denyOut: ["0.0.0.0/0"], allowPublicTraffic: false,
      rules: { "example.com": [{ transform: { headers: { authorization: "Bearer x" } } }] }
    }],
    ["it reports an egress proxy that was not requested", {
      denyOut: ["0.0.0.0/0"], allowPublicTraffic: false, egressProxy: { address: "proxy.example:1080" }
    }]
  ])("rejects a created sandbox when %s", async (_label, reported) => {
    const fake = makeFakeSandbox();
    const provider = makeProvider({ create: async () => fake.sandbox });
    provider.getInfo.mockResolvedValue({ network: reported });
    const { backend } = makeBackend({ fake, loader: provider.loader });

    await expect(backend.execute("echo x")).rejects.toThrow(/network policy was not applied/);
    expect(fake.killed).toHaveBeenCalledTimes(1);
    expect(fake.runCalls).toEqual([]);
  });

  it("reads the report of a new sandbox again after a failed read, and uses the sandbox", async () => {
    const fake = makeFakeSandbox();
    const provider = makeProvider({ create: async () => fake.sandbox });
    let failures = 2;
    provider.getInfo.mockImplementation(async (id: string) => {
      if (failures-- > 0) throw new Error("fetch failed");
      return provider.report(id);
    });
    const { backend } = makeBackend({ fake, loader: provider.loader });

    await expect(backend.execute("echo hi")).resolves.toMatchObject({ exitCode: 0 });

    expect(provider.getInfo).toHaveBeenCalledTimes(3);
    expect(fake.killed).not.toHaveBeenCalled();
  });

  it("kills a new sandbox that the provider cannot confirm: it held no work", async () => {
    const fake = makeFakeSandbox();
    const { binding } = makeBinding(null);
    const provider = makeProvider({ create: async () => fake.sandbox });
    breakReads(provider);
    const { backend } = makeBackend({ fake, loader: provider.loader, options: { sandboxBinding: binding } });

    await expect(backend.execute("echo secret")).rejects.toBeInstanceOf(SandboxNetworkPolicyUnconfirmedError);

    expect(provider.getInfo).toHaveBeenCalledTimes(4);
    expect(fake.killed).toHaveBeenCalledTimes(1);
    expect(fake.runCalls).toEqual([]);
    expect(binding.save).not.toHaveBeenCalled();
  });

  it("kills the new sandbox when the record under the session lease cannot be written", async () => {
    const fake = makeFakeSandbox();
    const owner = { current: "B" };
    // The lease belongs to another replica: the write of the record is refused.
    const { binding } = makeBinding(null, { owner, name: "A" });
    binding.load.mockResolvedValue(null);
    const { backend, provider } = makeBackend({ fake, options: { sandboxBinding: binding } });

    await expect(backend.execute("echo hi")).rejects.toMatchObject({ code: "execution_stopped" });

    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(fake.killed).toHaveBeenCalledTimes(1);
    expect(backend.id).toBe("deepagents-rt");
  });

  it("creates nothing when the policy of the tenant cannot be read", async () => {
    const fake = makeFakeSandbox();
    const { backend, provider } = makeBackend({
      fake, options: { resolveNetworkPolicy: async () => { throw new Error("db down"); } }
    });

    const failure = await backend.execute("echo hi").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SandboxNetworkPolicyUnconfirmedError);
    expect((failure as Error).message).toContain("network policy of the tenant could not be read");
    expect(provider.create).not.toHaveBeenCalled();
    expect(fake.runCalls).toEqual([]);
  });

  it("takes a file operation that creates the sandbox through the same create and confirm path", async () => {
    const fake = makeFakeSandbox();
    const order: string[] = [];
    const write = fake.sandbox.files.write;
    fake.sandbox.files.write = async (entries) => { order.push("write"); return write(entries); };
    const { backend, provider } = makeBackend({ fake, options: { resolveNetworkPolicy: async () => approved } });
    provider.getInfo.mockImplementation(async (id: string) => { order.push("read"); return provider.report(id); });

    await backend.uploadFiles([["/x.txt", new Uint8Array([1])]]);

    expect(provider.create.mock.calls[0]![1].network).toEqual(APPROVED_NETWORK);
    // The network is read back before anything is written.
    expect(order).toEqual(["read", "write"]);
  });

  it("writes no file into a created sandbox that does not match the policy", async () => {
    const fake = makeFakeSandbox();
    const provider = makeProvider({ create: async () => fake.sandbox });
    provider.getInfo.mockResolvedValue({ network: { denyOut: ["0.0.0.0/0"], allowPublicTraffic: true } });
    const { backend } = makeBackend({ fake, loader: provider.loader });

    await expect(backend.writeFileBytes("/x.txt", new Uint8Array([1]))).rejects.toBeInstanceOf(SandboxNetworkPolicyError);

    expect(fake.files.size).toBe(0);
    expect(fake.killed).toHaveBeenCalledTimes(1);
  });

  // ── The first use of each turn: one live read ──────────────────────────────

  it("reads the live network once at a reconnect, and the whole turn uses the result", async () => {
    const r = reconnect({ live: DENY_ALL_NETWORK });

    await r.backend.execute("true");
    await r.backend.execute("true");
    await r.backend.uploadFiles([["/x.txt", new Uint8Array([1])]]);
    await r.backend.readFileBytes("/x.txt");
    await r.backend.ls("/");

    expect(r.provider.getInfo).toHaveBeenCalledTimes(1);
    expect(r.provider.connect).toHaveBeenCalledTimes(1);
    expect(r.provider.create).not.toHaveBeenCalled();
    expect(r.saved.killed).not.toHaveBeenCalled();
    expect(r.onSandboxRecreated).not.toHaveBeenCalled();
    expect(r.binding.save).not.toHaveBeenCalled();
  });

  it("reads once more at the start of the next turn, and keeps a sandbox that still matches", async () => {
    const r = reconnect({ live: DENY_ALL_NETWORK });
    await r.backend.execute("true");

    r.backend.beginTurn();
    // Starting a turn calls no provider.
    expect(r.provider.getInfo).toHaveBeenCalledTimes(1);
    await r.backend.execute("true");
    await r.backend.execute("true");

    expect(r.provider.getInfo).toHaveBeenCalledTimes(2);
    expect(r.saved.killed).not.toHaveBeenCalled();
    expect(r.provider.create).not.toHaveBeenCalled();
  });

  it("compares the sandbox with the policy as it is at the turn start, not as it was at the last turn", async () => {
    const r = reconnect({ live: DENY_ALL_NETWORK });
    await r.backend.execute("true");
    r.settings.resolve.mockClear();

    r.backend.beginTurn();
    await r.backend.execute("echo hi");

    // The policy is read for the check of the new turn, once.
    expect(r.settings.resolve).toHaveBeenCalledTimes(1);
  });

  // The admin changed the list, a sandbox from before the policy, unexpected rules: the sandbox
  // does not match, and it is replaced. It is never changed.
  it("replaces the sandbox when the admin widened the list", async () => {
    const r = reconnect({ live: DENY_ALL_NETWORK, policy: approved });

    await r.backend.execute("echo hi");

    expectReplaced(r, approved, APPROVED_NETWORK);
    expect(r.backend.id).toBe("sbx-new");
  });

  it("replaces the sandbox when the admin narrowed the list", async () => {
    const r = reconnect({ live: APPROVED_NETWORK, policy: denyAll });

    await r.backend.execute("echo hi");

    expectReplaced(r, denyAll, DENY_ALL_NETWORK);
  });

  it("replaces the sandbox when the admin changed the list to other hosts", async () => {
    const r = reconnect({ live: APPROVED_NETWORK, policy: other });

    await r.backend.execute("echo hi");

    expectReplaced(r, other, OTHER_NETWORK);
  });

  it.each([
    ["reports no network configuration (it was created without options)", undefined],
    ["reports public URLs", { denyOut: ["0.0.0.0/0"], allowPublicTraffic: true }],
    ["does not report the URL setting", { denyOut: ["0.0.0.0/0"] }]
  ])("replaces a saved sandbox from before the policy that %s", async (_label, live) => {
    const r = reconnect({ live: live as E2bNetworkConfig | undefined });

    await r.backend.execute("echo hi");

    expectReplaced(r, denyAll, DENY_ALL_NETWORK);
  });

  it.each([
    ["has no deny-all entry", { allowOut: [], allowPublicTraffic: false }],
    ["has a deny list without the all-traffic entry", { denyOut: ["10.0.0.0/8"], allowPublicTraffic: false }],
    ["has an extra approved host", { denyOut: ["0.0.0.0/0"], allowOut: ["evil.example"], allowPublicTraffic: false }],
    ["has request rules", {
      denyOut: ["0.0.0.0/0"], allowPublicTraffic: false,
      rules: { "example.com": [{ transform: { headers: { authorization: "Bearer x" } } }] }
    }],
    ["has an egress proxy", { denyOut: ["0.0.0.0/0"], allowPublicTraffic: false, egressProxy: { address: "proxy.example:1080" } }]
  ])("replaces a sandbox that %s", async (_label, live) => {
    const r = reconnect({ live });

    await r.backend.execute("echo hi");

    expectReplaced(r, denyAll, DENY_ALL_NETWORK);
  });

  it("replaces the sandbox at the next turn when the admin changed the list in between, and not before", async () => {
    const r = reconnect({ live: DENY_ALL_NETWORK });
    await r.backend.execute("echo one");
    expect(r.saved.killed).not.toHaveBeenCalled();

    // The admin approves hosts during the turn. The turn goes on with the sandbox that it has.
    r.settings.state.current = approved;
    await r.backend.execute("echo hi");
    expect(r.provider.create).not.toHaveBeenCalled();

    // At the start of the next turn the sandbox is read, found not to match, and replaced.
    r.backend.beginTurn();
    await r.backend.execute("echo hi");
    expect(r.saved.runCalls.map((call) => call.command)).toEqual(["echo one", "echo hi"]);
    expect(r.saved.killed).toHaveBeenCalledTimes(1);
    expect(r.provider.create.mock.calls[0]![1].network).toEqual(APPROVED_NETWORK);
    expect(r.replacement.sandbox.reportedNetwork).toEqual(APPROVED_NETWORK);
    expect(r.state.saved).toEqual({ sandboxId: "sbx-new", networkPolicyHash: approved.hash });
    expect(r.onSandboxRecreated).toHaveBeenCalledWith({ previousSandboxId: "sbx-old", reason: "network_policy" });
  });

  it("replaces a sandbox once: the next turn finds that the new one matches", async () => {
    const r = reconnect({ live: DENY_ALL_NETWORK, policy: approved });
    await r.backend.execute("echo hi");

    r.backend.beginTurn();
    await r.backend.execute("echo again");

    expect(r.provider.create).toHaveBeenCalledTimes(1);
    expect(r.replacement.killed).not.toHaveBeenCalled();
    expect(r.onSandboxRecreated).toHaveBeenCalledTimes(1);
    expect(r.replacement.runCalls.map((call) => call.command)).toContain("echo again");
  });

  it("replaces a sandbox when the first operation of the turn is a file operation", async () => {
    const r = reconnect({ live: DENY_ALL_NETWORK, policy: approved });

    await r.backend.uploadFiles([["/x.txt", new Uint8Array([1])]]);

    // The file goes into the new sandbox, which matches. Nothing was written into the old one.
    expect(r.saved.files.size).toBe(0);
    expect(r.replacement.files.size).toBe(1);
    expect(r.saved.killed).toHaveBeenCalledTimes(1);
  });

  // ── Killing a sandbox that does not match ──────────────────────────────────
  // The kill is tried again after a failure, and the lease is checked before every try. A
  // sandbox that cannot be killed runs until the provider expires it, with the network that it
  // was created with, so a kill that still fails is logged as an error with the sandbox id.

  describe("killing a sandbox that does not match", () => {
    it("tries a failed kill again, checks the lease before every try, and replaces the sandbox when a try works", async () => {
      const order: string[] = [];
      const requireOwnership = vi.fn(async () => { order.push("lease"); });
      const r = reconnect({ live: DENY_ALL_NETWORK, policy: approved, options: { requireOwnership } });
      let tries = 0;
      r.saved.killed.mockImplementation(async () => {
        order.push("kill");
        if (++tries <= 2) throw new Error("kill failed");
      });
      const error = vi.spyOn(fakeLog, "error");

      await expect(r.backend.execute("echo hi")).resolves.toMatchObject({ exitCode: 0 });

      // Every kill, the two that failed too, is preceded by a lease check.
      expect(order).toEqual(["lease", "kill", "lease", "kill", "lease", "kill"]);
      expect(error).not.toHaveBeenCalled();
      expect(r.backend.id).toBe("sbx-new");
      expect(r.onSandboxRecreated).toHaveBeenCalledWith({ previousSandboxId: "sbx-old", reason: "network_policy" });
      error.mockRestore();
    });

    it("logs an error with the sandbox id when every try fails, and replaces the sandbox all the same", async () => {
      const r = reconnect({ live: DENY_ALL_NETWORK, policy: approved });
      r.saved.killed.mockRejectedValue(new Error("kill failed"));
      const error = vi.spyOn(fakeLog, "error");

      await expect(r.backend.execute("echo hi")).resolves.toMatchObject({ exitCode: 0 });

      // One try and three more.
      expect(r.saved.killed).toHaveBeenCalledTimes(4);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ sandboxId: "sbx-old", sessionId: "sess-1", tries: 4, err: expect.any(Error) }),
        expect.stringContaining("Failed to kill a replaced")
      );
      // The session goes on in a new sandbox that matches. The old one is left to expire.
      expect(r.backend.id).toBe("sbx-new");
      expect(r.state.saved).toEqual({ sandboxId: "sbx-new", networkPolicyHash: approved.hash });
      expect(r.onSandboxRecreated).toHaveBeenCalledWith({ previousSandboxId: "sbx-old", reason: "network_policy" });
      expect(r.replacement.runCalls.at(-1)?.command).toBe("echo hi");
      error.mockRestore();
    });

    it("stops the tries and fails closed when the lease is lost between two tries", async () => {
      let checks = 0;
      const requireOwnership = vi.fn(async () => {
        if (++checks > 1) throw Object.assign(new Error("execution_stopped"), { statusCode: 403 });
      });
      const r = reconnect({ live: DENY_ALL_NETWORK, policy: approved, options: { requireOwnership } });
      r.saved.killed.mockRejectedValue(new Error("kill failed"));
      const error = vi.spyOn(fakeLog, "error");

      const failure = await r.backend.execute("echo hi").catch((reason: unknown) => reason);

      // The second try never happened: the next owner may use this sandbox now.
      expect(failure).toBeInstanceOf(SandboxNetworkPolicyUnconfirmedError);
      expect((failure as Error).message).toContain("ownership of the session could not be confirmed");
      expect(r.saved.killed).toHaveBeenCalledTimes(1);
      expect(r.provider.create).not.toHaveBeenCalled();
      expect(r.onSandboxRecreated).not.toHaveBeenCalled();
      expect(r.saved.runCalls).toEqual([]);
      // This is not a sandbox that cannot be killed, so it is not logged as one.
      expect(error).not.toHaveBeenCalled();

      // The next call starts the replacement again, and finishes it.
      checks = -100;
      r.saved.killed.mockReset();
      await expect(r.backend.execute("echo hi")).resolves.toMatchObject({ exitCode: 0 });
      expect(r.saved.killed).toHaveBeenCalledTimes(1);
      expect(r.provider.create).toHaveBeenCalledTimes(1);
      error.mockRestore();
    });

    it("counts a sandbox that the provider no longer has as killed: no more tries, no error", async () => {
      const r = reconnect({ live: DENY_ALL_NETWORK, policy: approved });
      r.saved.killed.mockRejectedValue(gone());
      const error = vi.spyOn(fakeLog, "error");

      await expect(r.backend.execute("echo hi")).resolves.toMatchObject({ exitCode: 0 });

      expect(r.saved.killed).toHaveBeenCalledTimes(1);
      expect(error).not.toHaveBeenCalled();
      expect(r.backend.id).toBe("sbx-new");
      error.mockRestore();
    });

    it("does not try again once the turn is over", async () => {
      const r = reconnect({ live: DENY_ALL_NETWORK, policy: approved });
      r.saved.killed.mockImplementation(async () => {
        r.endTurn();
        throw new Error("kill failed");
      });

      await expect(r.backend.execute("echo hi")).rejects.toBeInstanceOf(SandboxTurnEndedError);

      expect(r.saved.killed).toHaveBeenCalledTimes(1);
      expect(r.provider.create).not.toHaveBeenCalled();
    });

    it("tries the kill of a new sandbox that failed its check again, and logs an error when it cannot kill it", async () => {
      const fake = makeFakeSandbox();
      fake.killed.mockRejectedValue(new Error("kill failed"));
      const requireOwnership = vi.fn(async () => {});
      const provider = makeProvider({ create: async () => fake.sandbox });
      provider.getInfo.mockResolvedValue({ network: undefined });
      const { backend } = makeBackend({ fake, loader: provider.loader, options: { requireOwnership } });
      const error = vi.spyOn(fakeLog, "error");

      // The caller sees why the sandbox was refused, not why it could not be killed.
      await expect(backend.execute("echo secret")).rejects.toBeInstanceOf(SandboxNetworkPolicyError);

      expect(fake.killed).toHaveBeenCalledTimes(4);
      expect(fake.runCalls).toEqual([]);
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ sandboxId: "sbx-123", tries: 4 }),
        expect.stringContaining("Failed to kill a new")
      );
      // Nobody else knows a sandbox that was never recorded, so no lease check stands in the way of its kill.
      expect(requireOwnership).not.toHaveBeenCalled();
      error.mockRestore();
    });
  });

  it("replaces a saved sandbox that the provider no longer has, without killing it", async () => {
    const r = reconnect({ live: DENY_ALL_NETWORK });
    r.provider.getInfo.mockImplementation(async (id: string) => {
      if (id === "sbx-old") throw gone();
      return r.provider.report(id);
    });

    await r.backend.execute("echo hi");

    expect(r.saved.killed).not.toHaveBeenCalled();
    expect(r.onSandboxRecreated).toHaveBeenCalledWith({ previousSandboxId: "sbx-old", reason: "expired" });
    expect(r.backend.id).toBe("sbx-new");
    expect(r.binding.save).toHaveBeenCalledWith("sbx-old", "sbx-new", denyAll.hash);
  });

  it("checks a reconnected sandbox once when operations start at the same time", async () => {
    const r = reconnect({ live: DENY_ALL_NETWORK, policy: approved });

    await Promise.all([
      r.backend.execute("echo a"),
      r.backend.execute("echo b"),
      r.backend.uploadFiles([["/x.txt", new Uint8Array([1])]])
    ]);

    // One read, one kill, one creation, for the three operations.
    expect(r.provider.getInfo.mock.calls.filter(([id]) => id === "sbx-old")).toHaveLength(1);
    expect(r.saved.killed).toHaveBeenCalledTimes(1);
    expect(r.provider.create).toHaveBeenCalledTimes(1);
    expect(r.onSandboxRecreated).toHaveBeenCalledTimes(1);
    expect(r.replacement.runCalls.map((call) => call.command).filter((command) => !command.startsWith("mkdir")).sort())
      .toEqual(["echo a", "echo b"]);
    expect(r.replacement.files.size).toBe(1);
  });

  // ── The sandbox cannot be read: fail closed, keep it ───────────────────────

  it("keeps the sandbox and fails the call when its network cannot be read at the turn start", async () => {
    const r = reconnect({ live: DENY_ALL_NETWORK, policy: approved });
    const reads = breakReads(r.provider);

    const failure = await r.backend.execute("echo secret").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SandboxNetworkPolicyUnconfirmedError);
    expect((failure as Error).message).toContain("No command was run");
    expect(r.provider.getInfo).toHaveBeenCalledTimes(4);
    // The sandbox is kept: not killed, not replaced, and nothing ran in it.
    expect(r.saved.killed).not.toHaveBeenCalled();
    expect(r.saved.runCalls).toEqual([]);
    expect(r.provider.create).not.toHaveBeenCalled();
    expect(r.onSandboxRecreated).not.toHaveBeenCalled();

    // The next call asks again, and the sandbox that does not match is replaced then.
    reads.heal();
    await r.backend.execute("echo hi");
    expect(r.provider.connect).toHaveBeenCalledTimes(1);
    expectReplaced(r, approved, APPROVED_NETWORK);
  });

  it("runs no command and no file operation in a sandbox that cannot be read, however many calls arrive", async () => {
    const r = reconnect({ live: DENY_ALL_NETWORK });
    breakReads(r.provider);

    const results = await Promise.allSettled([
      r.backend.execute("echo a"),
      r.backend.execute("echo b"),
      r.backend.ls("/"),
      r.backend.uploadFiles([["/x.txt", new Uint8Array([1])]]),
      r.backend.downloadFiles(["/x.txt"]),
      r.backend.readFileBytes("/x.txt"),
      r.backend.writeFileBytes("/y.txt", new Uint8Array([2]))
    ]);

    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(r.saved.runCalls).toEqual([]);
    expect(r.saved.files.size).toBe(0);
    expect(r.saved.killed).not.toHaveBeenCalled();
  });

  it("reads again after a failed read, and keeps the sandbox that matches", async () => {
    const r = reconnect({ live: DENY_ALL_NETWORK });
    let failures = 2;
    r.provider.getInfo.mockImplementation(async (id: string) => {
      if (failures-- > 0) throw new Error("fetch failed");
      return r.provider.report(id);
    });

    await expect(r.backend.execute("echo hi")).resolves.toMatchObject({ exitCode: 0 });

    expect(r.provider.getInfo).toHaveBeenCalledTimes(3);
    expect(r.saved.killed).not.toHaveBeenCalled();
    expect(r.provider.create).not.toHaveBeenCalled();
  });

  it("keeps the sandbox and fails the call when the policy of the tenant cannot be read at the turn start", async () => {
    const r = reconnect({ live: DENY_ALL_NETWORK });
    r.settings.resolve.mockRejectedValue(new Error("db down"));

    const failure = await r.backend.execute("echo hi").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SandboxNetworkPolicyUnconfirmedError);
    expect(r.saved.killed).not.toHaveBeenCalled();
    expect(r.saved.runCalls).toEqual([]);
    expect(r.provider.create).not.toHaveBeenCalled();
  });

  it("keeps the sandbox that cannot be read when the runtime has no saved record", async () => {
    const fake = makeFakeSandbox();
    const { backend, provider } = makeBackend({ fake });
    await backend.execute("echo one");
    backend.beginTurn();
    const reads = breakReads(provider);

    await expect(backend.execute("echo two")).rejects.toBeInstanceOf(SandboxNetworkPolicyUnconfirmedError);
    expect(fake.killed).not.toHaveBeenCalled();

    reads.heal();
    await backend.execute("echo three");

    // The same sandbox, with its files: nothing in the session points at another one.
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(fake.runCalls.map((call) => call.command)).not.toContain("echo two");
    expect(fake.runCalls.map((call) => call.command)).toContain("echo three");
  });

  // ── The lease: a runtime that lost the session replaces nothing ────────────

  it("checks the session lease before it kills a sandbox, and kills it only when the lease is current", async () => {
    const requireOwnership = vi.fn(async () => {});
    const r = reconnect({ live: DENY_ALL_NETWORK, policy: approved, options: { requireOwnership } });
    const order: string[] = [];
    requireOwnership.mockImplementation(async () => { order.push("lease"); });
    r.saved.killed.mockImplementation(async () => { order.push("kill"); });

    await r.backend.execute("echo hi");

    expect(order).toEqual(["lease", "kill"]);
  });

  it("neither kills nor replaces a sandbox, and fails closed, when the lease is lost", async () => {
    const requireOwnership = vi.fn(async () => {
      throw Object.assign(new Error("execution_stopped"), { statusCode: 403 });
    });
    const r = reconnect({ live: DENY_ALL_NETWORK, policy: approved, options: { requireOwnership } });

    const failure = await r.backend.execute("echo hi").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SandboxNetworkPolicyUnconfirmedError);
    expect((failure as Error).message).toContain("ownership of the session could not be confirmed");
    expect(r.saved.killed).not.toHaveBeenCalled();
    expect(r.provider.create).not.toHaveBeenCalled();
    expect(r.onSandboxRecreated).not.toHaveBeenCalled();
    expect(r.saved.runCalls).toEqual([]);
  });

  it("does not need the lease check for a sandbox that matches", async () => {
    const requireOwnership = vi.fn(async () => {});
    const r = reconnect({ live: DENY_ALL_NETWORK, options: { requireOwnership } });

    await r.backend.execute("echo hi");

    expect(requireOwnership).not.toHaveBeenCalled();
  });

  // ── A former owner ─────────────────────────────────────────────────────────
  // The only thing that a runtime that lost the session can still do to the network
  // is to create a new sandbox under the policy as it read it. It cannot change a
  // running sandbox, because there is no call for that. The next owner reads the
  // network at the start of its turn and replaces what does not match.

  describe("a former owner", () => {
    /** Two replicas of one session on one provider, one record under the session lease, one tenant policy. */
    function twoReplicas() {
      const owner = { current: "A" };
      const { binding, state } = makeBinding(null, undefined);
      // The record is written and read only under the lease, as the real store does.
      const leased = (name: string) => ({
        load: vi.fn(async () => {
          if (owner.current !== name) throw Object.assign(new Error("execution_stopped"), { code: "execution_stopped" });
          return binding.load();
        }),
        save: vi.fn(async (previousId: string | null, sandboxId: string, hash: string) => {
          if (owner.current !== name) throw Object.assign(new Error("execution_stopped"), { code: "execution_stopped" });
          return binding.save(previousId, sandboxId, hash);
        })
      });
      const settings = makeSettings(denyAll);
      const created: Array<ReturnType<typeof makeFakeSandbox>> = [];
      let nextId = 1;
      const held: { release?: () => void; gate?: Promise<void> } = {};
      const provider = makeProvider({
        create: async () => {
          const fake = makeFakeSandbox();
          fake.sandbox.sandboxId = `sbx-${nextId++}`;
          created.push(fake);
          if (held.gate) await held.gate;
          return fake.sandbox;
        },
        connect: async (id) => created.find((fake) => fake.sandbox.sandboxId === id)!.sandbox
      });
      const replica = (name: string) => makeBackend({
        fake: makeFakeSandbox(), loader: provider.loader,
        options: {
          sandboxBinding: leased(name), resolveNetworkPolicy: settings.resolve,
          requireOwnership: async () => {
            if (owner.current !== name) throw Object.assign(new Error("execution_stopped"), { statusCode: 403 });
          }
        }
      }).backend;
      return { owner, state, settings, provider, created, held, replica };
    }

    it("cannot keep a sandbox that it created under an old policy when the lease passed to another replica", async () => {
      const s = twoReplicas();
      const a = s.replica("A");
      const b = s.replica("B");
      // A reads the policy and starts to create. The provider is slow.
      const gate = new Promise<void>((resolve) => { s.held.release = resolve; });
      s.held.gate = gate;
      a.beginTurn();
      const creation = a.execute("echo A").catch((error: unknown) => error);
      await vi.waitFor(() => expect(s.provider.create).toHaveBeenCalledTimes(1));

      // The admin approves a host, the turn is cancelled, and B takes the lease.
      s.settings.state.current = approved;
      s.owner.current = "B";
      s.held.gate = undefined;
      s.held.release!();
      const outcome = await creation;

      // A's sandbox was created under the old policy. The record is written under the lease, so it is
      // refused, and A kills the sandbox: it is not kept by a replica that lost the session.
      expect(outcome).toMatchObject({ code: "execution_stopped" });
      expect(s.created[0]!.killed).toHaveBeenCalledTimes(1);
      expect(s.created[0]!.runCalls.filter((call) => !call.command.startsWith("mkdir"))).toEqual([]);
      expect(s.state.saved).toBeNull();

      // B starts its turn, and creates under the policy as it is now.
      b.beginTurn();
      await b.execute("echo B");
      expect(s.provider.create.mock.calls[1]![1].network).toEqual(APPROVED_NETWORK);
      expect(s.created[1]!.runCalls.map((call) => call.command)).toContain("echo B");
    });

    it("can keep a sandbox that it created under the policy it read before an admin change while it still holds the lease: the next owner replaces it", async () => {
      // This is the residual: between the read of the policy and the change, a sandbox exists under the old one.
      const s = twoReplicas();
      const a = s.replica("A");
      const b = s.replica("B");
      const gate = new Promise<void>((resolve) => { s.held.release = resolve; });
      s.held.gate = gate;
      a.beginTurn();
      const creation = a.execute("echo A");
      await vi.waitFor(() => expect(s.provider.create).toHaveBeenCalledTimes(1));
      // The admin approves a host while the sandbox is being created. A still holds the lease.
      s.settings.state.current = approved;
      s.held.gate = undefined;
      s.held.release!();
      await creation;
      expect(s.state.saved).toEqual({ sandboxId: "sbx-1", networkPolicyHash: denyAll.hash });
      expect(s.created[0]!.sandbox.reportedNetwork).toEqual(DENY_ALL_NETWORK);

      // A's turn ends, and B takes the lease. At the start of its turn B reads the network, finds that it does
      // not match the policy as it is now, and replaces the sandbox.
      s.owner.current = "B";
      b.beginTurn();
      await b.execute("echo B");

      expect(s.created[0]!.killed).toHaveBeenCalledTimes(1);
      expect(s.provider.create).toHaveBeenCalledTimes(2);
      expect(s.created[1]!.sandbox.reportedNetwork).toEqual(APPROVED_NETWORK);
      expect(s.created[1]!.runCalls.map((call) => call.command)).toContain("echo B");
      expect(s.state.saved).toEqual({ sandboxId: "sbx-2", networkPolicyHash: approved.hash });
    });

    it("cannot change the network of a sandbox that the next owner uses: its check finds a mismatch and replaces nothing", async () => {
      const s = twoReplicas();
      const a = s.replica("A");
      const b = s.replica("B");
      // B owns the session and uses a sandbox under deny-all.
      s.owner.current = "B";
      b.beginTurn();
      await b.execute("echo B1");
      expect(s.created).toHaveLength(1);

      // A did not notice that it lost the session. The policy that A reads is another one, so that
      // its check of B's sandbox finds a mismatch. It does not own the session: nothing is killed.
      s.settings.state.current = approved;
      a.beginTurn();
      const failure = await a.execute("echo A").catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect(s.created[0]!.killed).not.toHaveBeenCalled();
      expect(s.created[0]!.sandbox.reportedNetwork).toEqual(DENY_ALL_NETWORK);
      expect(s.provider.create).toHaveBeenCalledTimes(1);
      expect(s.created[0]!.runCalls.map((call) => call.command)).not.toContain("echo A");
      // And B goes on in its own turn, on the same sandbox.
      await b.execute("echo B2");
      expect(s.created[0]!.runCalls.map((call) => call.command)).toContain("echo B2");
    });
  });

  // ── What a check cannot adopt from an earlier turn ─────────────────────────

  describe("turns", () => {
    afterEach(() => { vi.useRealTimers(); });

    it("does not let a check that an earlier turn started confirm the next turn", async () => {
      const r = reconnect({ live: DENY_ALL_NETWORK });
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let first = true;
      r.provider.getInfo.mockImplementation(async (id: string) => {
        if (first) {
          first = false;
          await held;
        }
        return r.provider.report(id);
      });

      const turn1 = r.backend.execute("echo turn1").then(() => "ran", (error: unknown) => error);
      await vi.waitFor(() => expect(r.provider.getInfo).toHaveBeenCalledTimes(1));
      // The next turn begins while the read of the first is in flight.
      r.backend.beginTurn();
      release();

      // The first turn is over: its check does not carry on, and it runs nothing.
      expect(await turn1).toBeInstanceOf(SandboxNetworkPolicyUnconfirmedError);
      // The new turn reads for itself.
      await r.backend.execute("echo turn2");
      expect(r.provider.getInfo).toHaveBeenCalledTimes(2);
      expect(r.saved.runCalls.map((call) => call.command)).toEqual(["echo turn2"]);
    });

    it("does not let the next turn share the check of a turn that is over", async () => {
      const saved = existing("sbx-old", DENY_ALL_NETWORK);
      const { binding } = makeBinding({ sandboxId: "sbx-old", networkPolicyHash: denyAll.hash });
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const provider = makeProvider({ connect: async () => { await held; return saved.sandbox; } });
      const { backend } = makeBackend({ fake: saved, loader: provider.loader, options: { sandboxBinding: binding } });

      // Turn 1 waits for the connect, which is slow. Turn 2 begins while it still runs.
      const first = backend.execute("echo turn1").then(() => "ran", (error: unknown) => error);
      await vi.waitFor(() => expect(provider.connect).toHaveBeenCalledTimes(1));
      backend.beginTurn();
      const second = backend.execute("echo turn2").then(() => "ran", (error: unknown) => error);
      release();

      expect(await first).toBeInstanceOf(SandboxNetworkPolicyUnconfirmedError);
      expect(await second).toBe("ran");
      expect(saved.runCalls.map((call) => call.command)).toEqual(["echo turn2"]);
      expect(provider.connect).toHaveBeenCalledTimes(1);
    });

    /** The first read of the provider's report waits until the returned function is called. */
    function holdFirstRead(r: ReturnType<typeof reconnect>) {
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let first = true;
      r.provider.getInfo.mockImplementation(async (id: string) => {
        if (first) {
          first = false;
          await held;
        }
        return r.provider.report(id);
      });
      return release;
    }

    /** How an operation ended: "ran", or the error that it failed with. */
    const outcome = (operation: Promise<unknown>) => operation.then(() => "ran" as const, (error: unknown) => error);

    /**
     * A provider that makes `sbx-1` and then `sbx-2`. The first creation waits until `release()`.
     * The tenant approves hosts when the sandbox is first made, and `settings` can change that.
     */
    function slowFirstCreation(options: Partial<E2bDeepAgentsSandboxOptions> = {}) {
      const first = makeFakeSandbox();
      first.sandbox.sandboxId = "sbx-1";
      const second = makeFakeSandbox();
      second.sandbox.sandboxId = "sbx-2";
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let made = 0;
      const provider = makeProvider({ create: async () => (made++ === 0 ? (await held, first.sandbox) : second.sandbox) });
      const { binding, state } = makeBinding(null);
      const settings = makeSettings(approved);
      const { backend, endTurn } = makeBackend({
        fake: first, loader: provider.loader,
        options: { sandboxBinding: binding, resolveNetworkPolicy: settings.resolve, ...options }
      });
      return { first, second, release, provider, binding, state, settings, backend, endTurn };
    }

    // The creation of a sandbox belongs to the turn that began it. A turn that begins while a
    // sandbox is made for the turn before it has not compared that sandbox with its own policy.
    it("drops the creation that an earlier turn began when the next turn has begun: no command runs in that sandbox", async () => {
      const s = slowFirstCreation();
      const turn1 = outcome(s.backend.execute("echo turn1"));
      await vi.waitFor(() => expect(s.provider.create).toHaveBeenCalledTimes(1));
      // The admin removes every host, and the next turn begins, while the sandbox is made under the old list.
      s.settings.state.current = denyAll;
      s.backend.beginTurn();
      s.release();

      // The first operation fails: its turn is over.
      expect(await turn1).toBeInstanceOf(SandboxTurnEndedError);
      // The sandbox was made under the old list. Nothing ran in it, not even the workspace preparation.
      expect(s.first.sandbox.reportedNetwork).toEqual(APPROVED_NETWORK);
      expect(s.first.runCalls).toEqual([]);
      expect(s.first.killed).toHaveBeenCalledTimes(1);
      expect(s.binding.save).not.toHaveBeenCalled();
      expect(s.backend.id).toBe("deepagents-rt");

      // The new turn makes a sandbox of its own, under the policy as it is now.
      await s.backend.execute("echo turn2");
      expect(s.provider.create).toHaveBeenCalledTimes(2);
      expect(s.provider.create.mock.calls[1]![1].network).toEqual(DENY_ALL_NETWORK);
      expect(s.second.runCalls.map((call) => call.command)).toContain("echo turn2");
      expect(s.state.saved).toEqual({ sandboxId: "sbx-2", networkPolicyHash: denyAll.hash });
    });

    it("lets the next turn make a sandbox of its own when it waited for the creation that was dropped", async () => {
      const s = slowFirstCreation();
      const turn1 = outcome(s.backend.execute("echo turn1"));
      await vi.waitFor(() => expect(s.provider.create).toHaveBeenCalledTimes(1));
      s.settings.state.current = denyAll;
      s.backend.beginTurn();
      // This operation finds the creation of the first turn in progress, and waits for it.
      const turn2 = outcome(s.backend.execute("echo turn2"));
      s.release();

      expect(await turn1).toBeInstanceOf(SandboxTurnEndedError);
      expect(await turn2).toBe("ran");
      expect(s.first.runCalls).toEqual([]);
      expect(s.first.killed).toHaveBeenCalledTimes(1);
      expect(s.provider.create).toHaveBeenCalledTimes(2);
      expect(s.provider.create.mock.calls[1]![1].network).toEqual(DENY_ALL_NETWORK);
      expect(s.second.runCalls.map((call) => call.command)).toContain("echo turn2");
    });

    it("stops the creation before its first command when the turn ends, and when the runtime is disposed", async () => {
      const ended = slowFirstCreation();
      const first = outcome(ended.backend.execute("echo a"));
      await vi.waitFor(() => expect(ended.provider.create).toHaveBeenCalledTimes(1));
      ended.endTurn();
      ended.release();
      expect(await first).toBeInstanceOf(SandboxTurnEndedError);
      expect(ended.first.runCalls).toEqual([]);
      expect(ended.first.killed).toHaveBeenCalledTimes(1);
      expect(ended.binding.save).not.toHaveBeenCalled();

      const disposed = slowFirstCreation();
      const second = outcome(disposed.backend.execute("echo a"));
      await vi.waitFor(() => expect(disposed.provider.create).toHaveBeenCalledTimes(1));
      await disposed.backend.kill();
      disposed.release();
      expect(await second).toMatchObject({ message: expect.stringContaining("terminated") });
      expect(disposed.first.runCalls).toEqual([]);
      // The sandbox that the runtime was making is killed by the creation itself: the record that
      // would let the next runtime find it was never written.
      expect(disposed.first.killed).toHaveBeenCalledTimes(1);
      expect(disposed.binding.save).not.toHaveBeenCalled();
    });

    it("creates no sandbox for a turn that ended while the policy of the tenant was read", async () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const resolve = vi.fn(async () => { await held; return denyAll; });
      const { backend, provider, endTurn } = makeBackend({
        fake: makeFakeSandbox(), options: { resolveNetworkPolicy: resolve }
      });

      const operation = outcome(backend.execute("echo hi"));
      await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
      endTurn();
      release();

      expect(await operation).toBeInstanceOf(SandboxTurnEndedError);
      expect(provider.create).not.toHaveBeenCalled();
    });

    it("writes no record of a sandbox that was made for a turn that ended while its workspace was prepared", async () => {
      const fake = makeFakeSandbox();
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const run = fake.sandbox.commands.run;
      fake.sandbox.commands.run = async (command, options) => {
        const result = await run(command, options);
        await held;
        return result;
      };
      const { binding } = makeBinding(null);
      const { backend, endTurn } = makeBackend({ fake, options: { sandboxBinding: binding } });

      const operation = outcome(backend.execute("echo hi"));
      await vi.waitFor(() => expect(fake.runCalls).toHaveLength(1));
      endTurn();
      release();

      expect(await operation).toBeInstanceOf(SandboxTurnEndedError);
      expect(fake.runCalls.map((call) => call.command)).toEqual(["mkdir -p '/home/user/workspace/sess-1'"]);
      expect(binding.save).not.toHaveBeenCalled();
      expect(fake.killed).toHaveBeenCalledTimes(1);
      expect(backend.id).toBe("deepagents-rt");
    });

    // An operation takes its turn when it is called. The turn that began while it waited does not adopt it.
    it("does not let an operation that waits for the saved record adopt the turn that begins meanwhile", async () => {
      const r = reconnect({ live: DENY_ALL_NETWORK });
      await r.backend.execute("echo one");
      const reads = r.provider.getInfo.mock.calls.length;
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      r.binding.load.mockImplementationOnce(async () => { await held; return r.state.saved; });

      const stale = outcome(r.backend.execute("echo stale"));
      await vi.waitFor(() => expect(r.binding.load).toHaveBeenCalledTimes(2));
      r.backend.beginTurn();
      release();

      expect(await stale).toBeInstanceOf(SandboxTurnEndedError);
      expect(r.saved.runCalls.map((call) => call.command)).toEqual(["echo one"]);
      // It started no check for the new turn.
      expect(r.provider.getInfo).toHaveBeenCalledTimes(reads);

      // The new turn checks the sandbox for itself, and runs its own operations.
      await r.backend.execute("echo fresh");
      expect(r.provider.getInfo).toHaveBeenCalledTimes(reads + 1);
      expect(r.saved.runCalls.map((call) => call.command)).toEqual(["echo one", "echo fresh"]);
    });

    it("keeps the retry of a file operation in its own turn: a sandbox that went away is not replaced for the next turn", async () => {
      const r = reconnect({ live: DENY_ALL_NETWORK });
      await r.backend.execute("echo one");
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let started = false;
      r.saved.sandbox.files.write = async () => {
        started = true;
        await held;
        throw gone();
      };

      const upload = outcome(r.backend.uploadFiles([["/x.txt", new Uint8Array([1])]]));
      await vi.waitFor(() => expect(started).toBe(true));
      r.backend.beginTurn();
      release();

      expect(await upload).toBeInstanceOf(SandboxTurnEndedError);
      // No sandbox was made for it, and nothing was written anywhere.
      expect(r.provider.create).not.toHaveBeenCalled();
      expect(r.replacement.files.size).toBe(0);
    });

    // Dispose, cancellation and completion end the turn. Nothing that it asked for runs after that.
    it("runs nothing when the runtime is disposed while its check waits for the provider", async () => {
      const r = reconnect({ live: DENY_ALL_NETWORK });
      const release = holdFirstRead(r);
      const operation = outcome(r.backend.execute("echo hi"));
      await vi.waitFor(() => expect(r.provider.getInfo).toHaveBeenCalledTimes(1));
      await r.backend.kill();
      release();

      expect(await operation).toMatchObject({ message: expect.stringContaining("terminated") });
      expect(r.saved.runCalls).toEqual([]);
      expect(r.saved.files.size).toBe(0);
    });

    it("neither kills nor replaces a sandbox that does not match when the runtime was disposed meanwhile", async () => {
      const r = reconnect({ live: DENY_ALL_NETWORK, policy: approved });
      const release = holdFirstRead(r);
      const operation = outcome(r.backend.execute("echo hi"));
      await vi.waitFor(() => expect(r.provider.getInfo).toHaveBeenCalledTimes(1));
      await r.backend.kill();
      release();

      expect(await operation).toMatchObject({ message: expect.stringContaining("terminated") });
      expect(r.saved.killed).not.toHaveBeenCalled();
      expect(r.provider.create).not.toHaveBeenCalled();
      expect(r.onSandboxRecreated).not.toHaveBeenCalled();
    });

    it("ends the turn when its signal aborts: the operation that waits fails, and later ones are refused", async () => {
      const controller = new AbortController();
      const r = reconnect({ live: DENY_ALL_NETWORK });
      r.backend.beginTurn(controller.signal);
      const release = holdFirstRead(r);

      const waiting = outcome(r.backend.execute("echo waiting"));
      await vi.waitFor(() => expect(r.provider.getInfo).toHaveBeenCalledTimes(1));
      controller.abort();
      release();

      expect(await waiting).toBeInstanceOf(SandboxTurnEndedError);
      await expect(r.backend.execute("echo later")).rejects.toBeInstanceOf(SandboxTurnEndedError);
      await expect(r.backend.uploadFiles([["/x.txt", new Uint8Array([1])]])).rejects.toBeInstanceOf(SandboxTurnEndedError);
      expect(r.saved.runCalls).toEqual([]);
      expect(r.saved.files.size).toBe(0);
    });

    it("refuses every operation of a turn that begins with a signal that has already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      const r = reconnect({ live: DENY_ALL_NETWORK });
      r.backend.beginTurn(controller.signal);

      await expect(r.backend.execute("echo hi")).rejects.toBeInstanceOf(SandboxTurnEndedError);
      expect(r.provider.connect).not.toHaveBeenCalled();
      expect(r.provider.getInfo).not.toHaveBeenCalled();
    });

    it("does not leave a listener on the signal of a turn that ended", async () => {
      const controller = new AbortController();
      const add = vi.spyOn(controller.signal, "addEventListener");
      const remove = vi.spyOn(controller.signal, "removeEventListener");
      const { backend } = makeBackend({ fake: makeFakeSandbox(), beginTurn: false });

      const end = backend.beginTurn(controller.signal);
      end();

      expect(add).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]![1]);
    });

    it("refuses every operation of a turn that ended, and the next turn works", async () => {
      const r = reconnect({ live: DENY_ALL_NETWORK });
      await r.backend.execute("echo one");
      r.endTurn();

      await expect(r.backend.execute("echo two")).rejects.toBeInstanceOf(SandboxTurnEndedError);
      await expect(r.backend.uploadFiles([["/x.txt", new Uint8Array([1])]])).rejects.toBeInstanceOf(SandboxTurnEndedError);
      await expect(r.backend.downloadFiles(["/x.txt"])).rejects.toBeInstanceOf(SandboxTurnEndedError);
      await expect(r.backend.readFileBytes("/x.txt")).rejects.toBeInstanceOf(SandboxTurnEndedError);
      await expect(r.backend.statFile("/x.txt")).rejects.toBeInstanceOf(SandboxTurnEndedError);
      await expect(r.backend.writeFileBytes("/x.txt", "x")).rejects.toBeInstanceOf(SandboxTurnEndedError);
      expect(r.saved.runCalls.map((call) => call.command)).toEqual(["echo one"]);
      expect(r.saved.files.size).toBe(0);

      r.backend.beginTurn();
      await r.backend.execute("echo three");
      expect(r.saved.runCalls.map((call) => call.command)).toEqual(["echo one", "echo three"]);
    });

    it("ends only its own turn: the function of an earlier turn does not end the next one", async () => {
      const r = reconnect({ live: DENY_ALL_NETWORK });
      r.backend.beginTurn();

      r.endTurn();
      r.endTurn();

      await expect(r.backend.execute("echo next")).resolves.toMatchObject({ exitCode: 0 });
    });

    it("refuses an operation when no turn has begun, and calls nobody", async () => {
      const settings = makeSettings(denyAll);
      const { backend, provider } = makeBackend({
        fake: makeFakeSandbox(), beginTurn: false, options: { resolveNetworkPolicy: settings.resolve }
      });

      await expect(backend.execute("echo hi")).rejects.toBeInstanceOf(SandboxNetworkPolicyUnconfirmedError);
      await expect(backend.writeFileBytes("/x.txt", "x")).rejects.toBeInstanceOf(SandboxNetworkPolicyUnconfirmedError);

      expect(provider.create).not.toHaveBeenCalled();
      expect(provider.connect).not.toHaveBeenCalled();
      expect(provider.getInfo).not.toHaveBeenCalled();
      expect(settings.resolve).not.toHaveBeenCalled();
    });

    it("runs no command in a new sandbox whose turn ended while its network was read back", async () => {
      const fake = makeFakeSandbox();
      const provider = makeProvider({ create: async () => fake.sandbox });
      const { binding } = makeBinding(null);
      const { backend, endTurn } = makeBackend({ fake, loader: provider.loader, options: { sandboxBinding: binding } });
      provider.getInfo.mockImplementation(async (id: string) => {
        const report = provider.report(id);
        endTurn();
        return report;
      });

      await expect(backend.execute("echo hi")).rejects.toBeInstanceOf(SandboxTurnEndedError);

      // The report matched, and the turn was over when it came back: not even the workspace preparation ran.
      expect(fake.runCalls).toEqual([]);
      expect(fake.killed).toHaveBeenCalledTimes(1);
      expect(binding.save).not.toHaveBeenCalled();
    });

    // The last check sits between the acquisition and the request, with nothing awaited in between. These
    // two cases end the turn at that moment, which only a check of its own can see: the acquisition has
    // already found the turn live. They reach the private method on purpose.
    function endTurnAfterAcquisition(r: ReturnType<typeof reconnect>, nth: number) {
      const internals = r.backend as unknown as { acquireSandbox: (turn: unknown) => Promise<unknown> };
      const acquire = internals.acquireSandbox.bind(r.backend);
      let calls = 0;
      internals.acquireSandbox = async (turn) => {
        const acquired = await acquire(turn);
        if (++calls === nth) r.endTurn();
        return acquired;
      };
    }

    it("checks the turn once more when the sandbox is acquired, before the command is sent", async () => {
      const r = reconnect({ live: DENY_ALL_NETWORK });
      await r.backend.execute("echo one");
      endTurnAfterAcquisition(r, 1);

      await expect(r.backend.execute("echo two")).rejects.toBeInstanceOf(SandboxTurnEndedError);

      expect(r.saved.runCalls.map((call) => call.command)).toEqual(["echo one"]);
    });

    it("checks the turn once more before the retry of an operation after the sandbox went away", async () => {
      const r = reconnect({ live: DENY_ALL_NETWORK });
      await r.backend.execute("echo one");
      r.saved.sandbox.files.read = async () => { throw gone(); };
      const read = vi.fn(r.replacement.sandbox.files.read);
      r.replacement.sandbox.files.read = read;
      // The first acquisition finds the sandbox. The second is the retry, and the turn ends as it returns.
      endTurnAfterAcquisition(r, 2);

      await expect(r.backend.readFileBytes("/x.txt")).rejects.toBeInstanceOf(SandboxTurnEndedError);

      expect(read).not.toHaveBeenCalled();
    });

    // A step that sends several requests asks again before each.
    it("writes no more files of a batch once the turn has ended", async () => {
      const r = reconnect({ live: DENY_ALL_NETWORK });
      await r.backend.execute("echo one");
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const write = r.saved.sandbox.files.write;
      let first = true;
      r.saved.sandbox.files.write = async (entries) => {
        await write(entries);
        if (first) {
          first = false;
          await held;
        }
      };

      const upload = outcome(r.backend.uploadFiles([["/a.txt", new Uint8Array([1])], ["/b.txt", new Uint8Array([2])]]));
      await vi.waitFor(() => expect(r.saved.files.size).toBe(1));
      r.endTurn();
      release();

      // The call fails. It does not report the second file as failed, and it does not write it.
      expect(await upload).toBeInstanceOf(SandboxTurnEndedError);
      expect([...r.saved.files.keys()]).toEqual(["/home/user/workspace/sess-1/a.txt"]);
    });

    it("reads no more files of a batch once the turn has ended", async () => {
      const r = reconnect({ live: DENY_ALL_NETWORK });
      await r.backend.execute("echo one");
      await r.backend.writeFileBytes("/a.txt", "a");
      await r.backend.writeFileBytes("/b.txt", "b");
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const read = vi.fn(r.saved.sandbox.files.read);
      r.saved.sandbox.files.read = async (path: string) => {
        const content = await read(path);
        if (read.mock.calls.length === 1) await held;
        return content;
      };

      const download = outcome(r.backend.downloadFiles(["/a.txt", "/b.txt"]));
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
      r.endTurn();
      release();

      expect(await download).toBeInstanceOf(SandboxTurnEndedError);
      expect(read).toHaveBeenCalledTimes(1);
    });

    it("reads the report no more once the turn is over", async () => {
      const r = reconnect({ live: DENY_ALL_NETWORK });
      r.provider.getInfo.mockImplementation(async () => {
        r.endTurn();
        throw new Error("fetch failed");
      });

      await expect(r.backend.execute("echo hi")).rejects.toBeInstanceOf(SandboxTurnEndedError);

      // The read is not tried again for a turn that is over.
      expect(r.provider.getInfo).toHaveBeenCalledTimes(1);
      expect(r.saved.runCalls).toEqual([]);
    });
  });

  // ── Methods that deepagents' BaseSandbox gives to this class ───────────────
  // BaseSandbox builds every file method from three primitives, and each primitive takes the
  // turn that is current when it is called. A method of one step takes its turn when it is
  // called. A method of several steps would take one per step, so edit and delete run on a
  // view bound to the turn of the call (the table above the overrides in the source). These
  // cases hold the audit against the installed package, and then hold a step in the middle of
  // each method that has several: a turn that began meanwhile must not run the later step.

  describe("methods inherited from BaseSandbox", () => {
    const outcome = (operation: Promise<unknown>) => operation.then(() => "ran" as const, (error: unknown) => error);
    const WORKSPACE_FILE = (name: string) => `/home/user/workspace/sess-1/${name}`;
    const text = (bytes: Uint8Array | undefined) => (bytes ? new TextDecoder().decode(bytes) : undefined);

    /** A confirmed sandbox with a text file in it, and a record of the primitives that are reached afterwards. */
    async function started() {
      const r = reconnect({ live: DENY_ALL_NETWORK });
      await r.backend.execute("true");
      await r.backend.writeFileBytes("/a.txt", "one two");
      const steps: string[] = [];
      const run = r.saved.sandbox.commands.run;
      r.saved.sandbox.commands.run = async (command, options) => { steps.push("run"); return run(command, options); };
      const read = r.saved.sandbox.files.read;
      r.saved.sandbox.files.read = async (path: string) => { steps.push("read"); return read(path); };
      const write = r.saved.sandbox.files.write;
      r.saved.sandbox.files.write = async (entries) => { steps.push("write"); return write(entries); };
      return { ...r, steps };
    }

    const methods: Array<{ name: string; steps: string[]; call: (b: E2bDeepAgentsSandbox) => Promise<unknown> }> = [
      { name: "ls", steps: ["run"], call: (b) => b.ls("/") },
      { name: "read", steps: ["run"], call: (b) => b.read("/a.txt") },
      { name: "read of a file that is not text", steps: ["read"], call: (b) => b.read("/a.png") },
      { name: "readRaw", steps: ["read"], call: (b) => b.readRaw("/a.txt") },
      { name: "grep", steps: ["run"], call: (b) => b.grep("one", "/") },
      { name: "glob", steps: ["run"], call: (b) => b.glob("*.txt", "/") },
      { name: "write", steps: ["write"], call: (b) => b.write("/w.txt", "text") },
      { name: "edit", steps: ["read", "write"], call: (b) => b.edit("/a.txt", "one", "uno") },
      { name: "delete", steps: ["run", "run"], call: (b) => b.delete("/a.txt") }
    ];

    it("inherits exactly the methods that were audited", () => {
      // A method that a deepagents upgrade adds is not in the table of the source: audit it, then add it here.
      const names = Object.getOwnPropertyNames(BaseSandbox.prototype).filter((name) => name !== "constructor").sort();
      expect(names).toEqual(["delete", "edit", "glob", "grep", "ls", "read", "readRaw", "write"]);
    });

    it.each(methods)("is made of the steps that were audited: $name", async ({ steps, call }) => {
      const s = await started();

      await call(s.backend);

      expect(s.steps).toEqual(steps);
    });

    it.each(methods)("takes its turn when it is called, not when it starts to work: $name", async ({ call }) => {
      const s = await started();

      const operation = outcome(call(s.backend));
      s.backend.beginTurn();

      // The next turn began before the first step ran. The call belongs to the turn before, and it runs nothing.
      expect(await operation).toBeInstanceOf(SandboxTurnEndedError);
      expect(s.steps).toEqual([]);
    });

    it.each(methods)("runs nothing once its turn has ended: $name", async ({ call }) => {
      const s = await started();
      s.endTurn();

      await expect(call(s.backend)).rejects.toBeInstanceOf(SandboxTurnEndedError);

      expect(s.steps).toEqual([]);
    });

    it.each(methods)("runs nothing on a runtime that has no turn: $name", async ({ call }) => {
      const fake = makeFakeSandbox();
      const { backend, provider } = makeBackend({ fake, beginTurn: false });

      await expect(call(backend)).rejects.toBeInstanceOf(SandboxNetworkPolicyUnconfirmedError);

      expect(provider.create).not.toHaveBeenCalled();
      expect(provider.getInfo).not.toHaveBeenCalled();
      expect(fake.runCalls).toEqual([]);
    });

    // The view that edit and delete run on. These cases use it directly, so that each of its three
    // primitives is held to the turn of the call by a case of its own, and not only by the steps that
    // edit and delete happen to make today.
    it("binds each primitive of the view to the turn that was current when the view was made", async () => {
      const s = await started();
      const view = (s.backend as unknown as { scopedToCurrentTurn: () => E2bDeepAgentsSandbox }).scopedToCurrentTurn();
      s.backend.beginTurn();

      await expect(view.execute("echo stale")).rejects.toBeInstanceOf(SandboxTurnEndedError);
      await expect(view.uploadFiles([["/x.txt", new Uint8Array([1])]])).rejects.toBeInstanceOf(SandboxTurnEndedError);
      await expect(view.downloadFiles(["/a.txt"])).rejects.toBeInstanceOf(SandboxTurnEndedError);
      expect(s.steps).toEqual([]);
      // The sandbox itself takes the turn that is current now, and it works.
      await expect(s.backend.execute("echo fresh")).resolves.toMatchObject({ exitCode: 0 });
      // The view is made of the sandbox: it has its options and its methods, and the sandbox is not changed by it.
      expect(view.id).toBe(s.backend.id);
      expect(Object.prototype.hasOwnProperty.call(s.backend, "execute")).toBe(false);
    });

    // ── edit: download, wait, upload ─────────────────────────────────────────

    /** The first read of a file waits until `release()`, and returns what the file held when it was read. */
    function holdFirstDownload(r: Awaited<ReturnType<typeof started>>) {
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const read = r.saved.sandbox.files.read;
      let reads = 0;
      r.saved.sandbox.files.read = async (path: string) => {
        const content = await read(path);
        if (++reads === 1) await held;
        return content;
      };
      return { release, started: () => reads > 0 };
    }

    it("does not let the upload of an edit run in the turn that began while its download waited", async () => {
      const s = await started();
      const gate = holdFirstDownload(s);

      const edit = outcome(s.backend.edit("/a.txt", "one", "uno"));
      await vi.waitFor(() => expect(gate.started()).toBe(true));
      // The next turn begins and writes the file, while the download of the first one is still on its way.
      s.backend.beginTurn();
      await s.backend.writeFileBytes("/a.txt", "written by the next turn");
      const loads = s.binding.load.mock.calls.length;
      s.steps.length = 0;
      gate.release();

      // What the first turn found in the file is old, and its edit must not overwrite the new file.
      expect(await edit).toBeInstanceOf(SandboxTurnEndedError);
      expect(text(s.saved.files.get(WORKSPACE_FILE("a.txt")))).toBe("written by the next turn");
      expect(s.steps).toEqual([]);
      // The step that is refused does not even read the saved record: its turn is over.
      expect(s.binding.load).toHaveBeenCalledTimes(loads);
    });

    it("does not upload what an edit found once its turn has ended", async () => {
      const s = await started();
      const gate = holdFirstDownload(s);

      const edit = outcome(s.backend.edit("/a.txt", "one", "uno"));
      await vi.waitFor(() => expect(gate.started()).toBe(true));
      s.endTurn();
      gate.release();

      expect(await edit).toBeInstanceOf(SandboxTurnEndedError);
      expect(text(s.saved.files.get(WORKSPACE_FILE("a.txt")))).toBe("one two");
    });

    it("edits a file in the turn that called it: one download, one upload, the text replaced", async () => {
      const s = await started();

      const result = await s.backend.edit("/a.txt", "one", "uno");

      expect(result).toEqual({ path: "/a.txt", filesUpdate: null, occurrences: 1 });
      expect(text(s.saved.files.get(WORKSPACE_FILE("a.txt")))).toBe("uno two");
      expect(s.steps).toEqual(["read", "write"]);
      // The primitives of the view are the ones of the sandbox: the workspace remap and the lifetime are the same.
      expect(await s.backend.edit("/a.txt", "o", "0", true)).toMatchObject({ occurrences: 2 });
      expect(text(s.saved.files.get(WORKSPACE_FILE("a.txt")))).toBe("un0 tw0");
    });

    it("reports an edit that cannot be done without uploading anything", async () => {
      const s = await started();

      expect(await s.backend.edit("/a.txt", "missing", "x")).toMatchObject({ error: expect.stringContaining("String not found") });
      expect(await s.backend.edit("/a.txt", "o", "0")).toMatchObject({ error: expect.stringContaining("Multiple occurrences") });
      expect(await s.backend.edit("/nope.txt", "a", "b")).toMatchObject({ error: expect.stringContaining("not found") });
      expect(s.steps.filter((step) => step === "write")).toEqual([]);
    });

    it("keeps an edit that retries after the sandbox went away in the turn of the call", async () => {
      const s = await started();
      const read = s.saved.sandbox.files.read;
      let reads = 0;
      s.saved.sandbox.files.read = async (path: string) => {
        // The first download finds the sandbox gone, and the retry runs in a new sandbox that has no file.
        if (++reads === 1) throw gone();
        return read(path);
      };
      s.replacement.sandbox.files.read = async () => { throw new Error("file not found"); };
      s.backend.beginTurn();

      // The new turn has no sandbox yet, and the edit is made in it: the call and its retry are of that turn.
      const result = await s.backend.edit("/a.txt", "one", "uno");

      expect(result).toMatchObject({ error: expect.stringContaining("not found") });
      expect(s.provider.create).toHaveBeenCalledTimes(1);
    });

    // ── delete: ask, wait, remove ────────────────────────────────────────────

    /** The probe of delete (`test -e`) waits until `release()`. */
    function holdProbe(r: Awaited<ReturnType<typeof started>>) {
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const run = r.saved.sandbox.commands.run;
      let probed = false;
      r.saved.sandbox.commands.run = async (command, options) => {
        const result = await run(command, options);
        if (command.startsWith("test -e") && !probed) {
          probed = true;
          await held;
        }
        return result;
      };
      return { release, started: () => probed };
    }
    const commandsRun = (r: Awaited<ReturnType<typeof started>>) => r.saved.runCalls.map((call) => call.command);

    it("does not let the rm of a delete run in the turn that began while its probe waited", async () => {
      const s = await started();
      const gate = holdProbe(s);

      const removal = outcome(s.backend.delete("/a.txt"));
      await vi.waitFor(() => expect(gate.started()).toBe(true));
      s.backend.beginTurn();
      await s.backend.writeFileBytes("/a.txt", "written by the next turn");
      const before = commandsRun(s).length;
      gate.release();

      expect(await removal).toBeInstanceOf(SandboxTurnEndedError);
      // The probe found the file, and the file is the next turn's now: nothing removes it.
      expect(commandsRun(s).slice(before)).toEqual([]);
      expect(commandsRun(s).some((command) => command.startsWith("rm "))).toBe(false);
      expect(text(s.saved.files.get(WORKSPACE_FILE("a.txt")))).toBe("written by the next turn");
    });

    it("does not remove what a delete found once its turn has ended", async () => {
      const s = await started();
      const gate = holdProbe(s);

      const removal = outcome(s.backend.delete("/a.txt"));
      await vi.waitFor(() => expect(gate.started()).toBe(true));
      s.endTurn();
      gate.release();

      expect(await removal).toBeInstanceOf(SandboxTurnEndedError);
      expect(commandsRun(s).some((command) => command.startsWith("rm "))).toBe(false);
    });

    it("deletes inside the workspace, with the path that the model gave in the answer", async () => {
      const s = await started();

      const result = await s.backend.delete("/a.txt");

      // The model names the file as it does for write_file: from the root of the workspace.
      expect(commandsRun(s).slice(-2)).toEqual([
        `test -e '${WORKSPACE_FILE("a.txt")}' || test -L '${WORKSPACE_FILE("a.txt")}'`,
        `rm -rf '${WORKSPACE_FILE("a.txt")}'`
      ]);
      expect(result).toEqual({ path: "/a.txt", filesUpdate: null });
    });

    it("keeps a delete of a sandbox path inside the workspace as it is", async () => {
      const s = await started();

      const result = await s.backend.delete(WORKSPACE_FILE("a.txt"));

      expect(commandsRun(s).at(-1)).toBe(`rm -rf '${WORKSPACE_FILE("a.txt")}'`);
      expect(result).toMatchObject({ path: WORKSPACE_FILE("a.txt") });
    });

    it("refuses a path outside the workspace and runs no command for it", async () => {
      const s = await started();

      expect(await s.backend.delete("/../../etc/passwd")).toEqual({ error: "Path is outside the session workspace" });
      expect(await s.backend.delete("../x")).toEqual({ error: "Path is outside the session workspace" });
      expect(s.steps).toEqual([]);
    });

    it("answers that a path is not found, and does not run the rm", async () => {
      const s = await started();
      const run = s.saved.sandbox.commands.run;
      s.saved.sandbox.commands.run = async (command, options) =>
        command.startsWith("test -e") ? { stdout: "", stderr: "", exitCode: 1 } : run(command, options);

      const result = await s.backend.delete("/missing.txt");

      expect(result).toEqual({ error: `Error: '${WORKSPACE_FILE("missing.txt")}' not found` });
      expect(commandsRun(s).some((command) => command.startsWith("rm "))).toBe(false);
    });

    it("reports a rm that failed", async () => {
      const s = await started();
      const run = s.saved.sandbox.commands.run;
      s.saved.sandbox.commands.run = async (command, options) =>
        command.startsWith("rm ") ? { stdout: "rm: cannot remove: Permission denied", stderr: "", exitCode: 1 } : run(command, options);

      const result = await s.backend.delete("/a.txt");

      expect(result).toMatchObject({ error: expect.stringContaining("Permission denied") });
      expect(result.path).toBeUndefined();
    });
  });

  // ── Time limits: one deadline per check, one check per wait ────────────────
  // These cases run on fake timers, so that a provider that never answers costs
  // no real time, and the exact moments of each request can be checked.

  describe("time limits on a network check", () => {
    afterEach(() => { vi.useRealTimers(); });

    const BACKOFF = [250, 500, 1000];
    const never = () => new Promise<never>(() => {});

    /** How a promise ended. The promise is not awaited, so a test can move fake time while it is pending. */
    function track<T>(promise: Promise<T>) {
      const outcome: { state: "pending" | "resolved" | "rejected"; value?: T; error?: unknown } = { state: "pending" };
      promise.then(
        (value) => { outcome.state = "resolved"; outcome.value = value; },
        (error: unknown) => { outcome.state = "rejected"; outcome.error = error; }
      );
      return outcome;
    }

    const at = (ms: number) => vi.advanceTimersByTimeAsync(ms);

    /** A reconnected sandbox on deny-all and the default time limits, with fake timers. */
    function timed(input: { policy?: typeof denyAll; options?: Partial<E2bDeepAgentsSandboxOptions> } = {}) {
      vi.useFakeTimers();
      return reconnect({
        live: DENY_ALL_NETWORK, policy: input.policy ?? denyAll,
        options: { networkRetryBackoffMs: BACKOFF, ...input.options }
      });
    }

    /** The `requestTimeoutMs` of each request that the backend made to `getInfo`. */
    const readTimeouts = (r: ReturnType<typeof reconnect>) =>
      r.provider.getInfo.mock.calls.map((call) => call[1]?.requestTimeoutMs);

    it("gives up a read that gets no answer after the request timeout, cancels it, and reads again", async () => {
      const r = timed();
      let silent = true;
      r.provider.getInfo.mockImplementation((id: string) => {
        if (silent) {
          silent = false;
          return never();
        }
        return Promise.resolve(r.provider.report(id));
      });

      const operation = track(r.backend.execute("echo hi"));
      await at(4_999);
      expect(r.provider.getInfo).toHaveBeenCalledTimes(1);
      const limits = r.provider.getInfo.mock.calls[0]![1]!;
      expect(limits.requestTimeoutMs).toBe(5_000);
      expect(limits.signal?.aborted).toBe(false);

      await at(1);
      expect(limits.signal?.aborted).toBe(true);
      await at(249);
      expect(r.provider.getInfo).toHaveBeenCalledTimes(1);
      await at(1);
      expect(r.provider.getInfo).toHaveBeenCalledTimes(2);

      expect(operation.state).toBe("resolved");
      expect(r.saved.runCalls.map((call) => call.command)).toEqual(["echo hi"]);
      expect(r.saved.killed).not.toHaveBeenCalled();
    });

    it("never gives a request more time than the deadline has left, and fails closed at the deadline", async () => {
      const r = timed({ policy: approved });
      r.provider.getInfo.mockImplementation(() => never());

      const operation = track(r.backend.execute("echo secret"));
      // Tries at 0, 5250, 10750 and 16750 ms. The last one has 3250 ms left.
      await at(19_999);
      expect(operation.state).toBe("pending");
      expect(readTimeouts(r)).toEqual([5_000, 5_000, 5_000, 3_250]);
      await at(1);

      expect(operation.state).toBe("rejected");
      expect(operation.error).toBeInstanceOf(SandboxNetworkPolicyUnconfirmedError);
      expect((operation.error as Error).message).toContain("No command was run");
      // Not read, so not replaced: the sandbox is kept, though it would not match.
      expect(r.saved.runCalls).toEqual([]);
      expect(r.saved.killed).not.toHaveBeenCalled();
      expect(r.provider.create).not.toHaveBeenCalled();
      expect(r.onSandboxRecreated).not.toHaveBeenCalled();
    });

    it("shares one deadline between the reads of the report and the read of the policy", async () => {
      const r = timed();
      // The first three reads of the report get no answer, and the fourth, at 16750 ms, is answered at once.
      let reads = 0;
      r.provider.getInfo.mockImplementation((id: string) => (++reads < 4 ? never() : Promise.resolve(r.provider.report(id))));
      // The policy of the tenant is then read with the 3250 ms that are left, and it gets no answer.
      r.settings.resolve.mockImplementation(() => never());

      const operation = track(r.backend.execute("echo secret"));
      await at(19_999);
      expect(operation.state).toBe("pending");
      await at(1);

      expect(operation.state).toBe("rejected");
      expect(operation.error).toBeInstanceOf(SandboxNetworkPolicyUnconfirmedError);
      expect((operation.error as Error).message).toContain("network policy of the tenant could not be read");
      expect(r.saved.runCalls).toEqual([]);
      expect(r.saved.killed).not.toHaveBeenCalled();
      expect(r.provider.create).not.toHaveBeenCalled();
    });

    it("makes callers that wait share one check: the wait does not multiply", async () => {
      const r = timed();
      r.provider.getInfo.mockImplementation(() => never());

      const first = track(r.backend.execute("echo a"));
      const second = track(r.backend.uploadFiles([["/x.txt", new Uint8Array([1])]]));
      await at(10_000);
      // A caller that arrives in the middle of the check waits for the same one.
      const third = track(r.backend.execute("echo c"));
      await at(9_999);
      expect([first, second, third].map((outcome) => outcome.state)).toEqual(["pending", "pending", "pending"]);
      await at(1);

      expect([first, second, third].map((outcome) => outcome.state)).toEqual(["rejected", "rejected", "rejected"]);
      for (const outcome of [first, second, third]) expect(outcome.error).toBeInstanceOf(SandboxNetworkPolicyUnconfirmedError);
      // Four reads for all three callers, not four each.
      expect(r.provider.getInfo).toHaveBeenCalledTimes(4);
      expect(r.saved.runCalls).toEqual([]);
      expect(r.saved.files.size).toBe(0);
      expect(r.saved.killed).not.toHaveBeenCalled();
    });

    it("starts a new check for a call that arrives after a failed one", async () => {
      const r = timed();
      r.provider.getInfo.mockImplementation(() => never());
      const first = track(r.backend.execute("echo a"));
      await at(20_000);
      expect(first.state).toBe("rejected");
      const readsAfterFirst = r.provider.getInfo.mock.calls.length;

      // The provider recovers. The next call asks again, on the same sandbox.
      r.provider.getInfo.mockImplementation((id: string) => Promise.resolve(r.provider.report(id)));
      const second = track(r.backend.execute("echo b"));
      await at(0);

      expect(second.state).toBe("resolved");
      expect(r.provider.getInfo.mock.calls.length).toBe(readsAfterFirst + 1);
      expect(r.provider.connect).toHaveBeenCalledTimes(1);
      expect(r.provider.create).not.toHaveBeenCalled();
      expect(r.saved.runCalls.map((call) => call.command)).toEqual(["echo b"]);
    });

    it("shares one successful check too: the waiters run after it", async () => {
      const r = timed();
      r.provider.getInfo.mockImplementation((id: string) =>
        new Promise((resolve) => setTimeout(() => resolve(r.provider.report(id)), 3_000)));

      const calls = [r.backend.execute("echo a"), r.backend.execute("echo b"), r.backend.execute("echo c")].map(track);
      await at(2_999);
      expect(calls.map((call) => call.state)).toEqual(["pending", "pending", "pending"]);
      await at(1);

      expect(calls.map((call) => call.state)).toEqual(["resolved", "resolved", "resolved"]);
      expect(r.provider.getInfo).toHaveBeenCalledTimes(1);
      expect(r.saved.runCalls.map((call) => call.command).sort()).toEqual(["echo a", "echo b", "echo c"]);
    });

    it("takes both limits from the options", async () => {
      const r = timed({ options: { networkConfirmTimeoutMs: 3_000, networkRequestTimeoutMs: 1_000 } });
      r.provider.getInfo.mockImplementation(() => never());

      const operation = track(r.backend.execute("echo secret"));
      await at(2_999);
      expect(operation.state).toBe("pending");
      await at(1);

      // Tries at 0 (1000 ms), 1250 (1000 ms) and 2750 (250 ms left).
      expect(operation.state).toBe("rejected");
      expect(readTimeouts(r)).toEqual([1_000, 1_000, 250]);
    });

    it("applies the deadline to the check of a new sandbox, and kills that sandbox: nothing ran in it", async () => {
      vi.useFakeTimers();
      const fake = makeFakeSandbox();
      const provider = makeProvider({ create: async () => fake.sandbox });
      provider.getInfo.mockImplementation(() => never());
      const { backend } = makeBackend({
        fake, loader: provider.loader, options: { networkRetryBackoffMs: BACKOFF }
      });

      const operation = track(backend.execute("echo secret"));
      await at(19_999);
      expect(operation.state).toBe("pending");
      await at(1);

      expect(operation.state).toBe("rejected");
      expect(operation.error).toBeInstanceOf(SandboxNetworkPolicyUnconfirmedError);
      expect(fake.killed).toHaveBeenCalledTimes(1);
      expect(fake.runCalls).toEqual([]);
    });

    it("gives the kill of a sandbox the request timeout and the deadline, and goes on when no try is answered", async () => {
      const r = timed({ policy: approved });
      r.saved.killed.mockImplementation(() => never());
      const error = vi.spyOn(fakeLog, "error");

      const operation = track(r.backend.execute("echo hi"));
      // Tries at 0, 5250, 10750 and 16750 ms. The last one has 3250 ms left.
      await at(19_999);
      expect(operation.state).toBe("pending");
      expect(r.saved.killed.mock.calls.map((call) => call[0]?.requestTimeoutMs)).toEqual([5_000, 5_000, 5_000, 3_250]);
      expect(r.saved.killed.mock.calls.every((call) => call[0]?.signal instanceof AbortSignal)).toBe(true);
      expect(error).not.toHaveBeenCalled();
      await at(1);

      // Nothing is sent after the deadline. The failure is logged, and the replacement goes on.
      expect(r.saved.killed).toHaveBeenCalledTimes(4);
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ sandboxId: "sbx-old", tries: 4 }),
        expect.stringContaining("Failed to kill a replaced")
      );
      expect(operation.state).toBe("resolved");
      expect(r.backend.id).toBe("sbx-new");
      expect(r.replacement.runCalls.at(-1)?.command).toBe("echo hi");
      error.mockRestore();
    });

    it("goes on at the deadline of a kill, and asks for no lease that it can no longer use", async () => {
      const requireOwnership = vi.fn(async () => {});
      const r = timed({
        policy: approved,
        options: { requireOwnership, networkConfirmTimeoutMs: 3_000, networkRequestTimeoutMs: 1_000 }
      });
      r.saved.killed.mockImplementation(() => never());
      const error = vi.spyOn(fakeLog, "error");

      const operation = track(r.backend.execute("echo hi"));
      // Tries at 0 (1000 ms), 1250 (1000 ms) and 2750 (250 ms left). The deadline is at 3000: there is no fourth try.
      await at(3_000);

      expect(r.saved.killed.mock.calls.map((call) => call[0]?.requestTimeoutMs)).toEqual([1_000, 1_000, 250]);
      expect(requireOwnership).toHaveBeenCalledTimes(3);
      expect(error).toHaveBeenCalledWith(expect.objectContaining({ sandboxId: "sbx-old", tries: 3 }), expect.any(String));
      expect(operation.state).toBe("resolved");
      expect(r.backend.id).toBe("sbx-new");
      error.mockRestore();
    });

    it("does not kill a sandbox when the lease check gets no answer in time: the call fails closed", async () => {
      const r = timed({ policy: approved, options: { requireOwnership: () => never() } });

      const operation = track(r.backend.execute("echo hi"));
      await at(4_999);
      expect(operation.state).toBe("pending");
      await at(1);

      expect(operation.state).toBe("rejected");
      expect(operation.error).toBeInstanceOf(SandboxNetworkPolicyUnconfirmedError);
      expect((operation.error as Error).message).toContain("ownership of the session could not be confirmed");
      expect(r.saved.killed).not.toHaveBeenCalled();
      expect(r.provider.create).not.toHaveBeenCalled();
    });

    it("does not leave a timer behind when the requests are answered", async () => {
      const r = timed();

      await r.backend.execute("echo hi");

      // No request timer or backoff timer outlives a check that succeeded.
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
