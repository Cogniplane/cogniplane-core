import { createSilentLogger } from "../../test-helpers/silent-logger.js";
import { describe, expect, it, vi } from "vitest";

import {
  E2bDeepAgentsSandbox,
  isSandboxGoneError,
  type E2bDeepAgentsSandboxOptions
} from "./deep-agents-e2b-backend.js";
import type { loadE2bSandboxClass } from "../runtime/e2b-sandbox.js";

const fakeLog = createSilentLogger();

type RunCall = { command: string; options?: Record<string, unknown> };

function makeFakeSandbox(overrides: {
  runResult?: (command: string) => unknown | Promise<unknown>;
} = {}) {
  const runCalls: RunCall[] = [];
  const files = new Map<string, Uint8Array>();
  const killed = vi.fn(async () => {});
  const setTimeoutCalls: number[] = [];
  const sandbox = {
    sandboxId: "sbx-123",
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
  return { sandbox, runCalls, files, killed, setTimeoutCalls };
}

function makeBackend(input: {
  fake: ReturnType<typeof makeFakeSandbox>;
  createSpy?: ReturnType<typeof vi.fn>;
  options?: Partial<E2bDeepAgentsSandboxOptions>;
}) {
  const create =
    input.createSpy ??
    vi.fn(async () => input.fake.sandbox);
  const loader = (async () => ({ create })) as unknown as typeof loadE2bSandboxClass;
  const backend = new E2bDeepAgentsSandbox({
    apiKey: "e2b-key",
    templateId: "tpl-slim",
    sandboxTimeoutMs: 60_000,
    executeTimeoutMs: 5_000,
    workspacePath: "/home/user/workspace/sess-1",
    sessionId: "sess-1",
    runtimeId: "deepagents-rt",
    logger: fakeLog,
    loadSandboxClass: loader,
    ...input.options
  });
  return { backend, create };
}

describe("E2bDeepAgentsSandbox", () => {
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
    // ROBUSTNESS GAP (documented, not endorsed): the streaming-RPC-drop message
    // ("... not running anymore") the fallback comment cites is NOT matched by
    // the current regex ("not running anymore" ≠ "no longer running"). Today
    // this is harmless — the SDK throws it as a real SandboxNotFoundError caught
    // by the NAME branch — but pinning it documents the gap so broadening the
    // regex later is a deliberate, test-visible change.
    expect(isSandboxGoneError(new Error("Sandbox is probably not running anymore"))).toBe(false);
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
    expect(onSandboxRecreated).toHaveBeenCalledWith({ previousSandboxId: "sbx-123" });
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
    expect(onSandboxRecreated).toHaveBeenCalledWith({ previousSandboxId: "sbx-123" });
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
