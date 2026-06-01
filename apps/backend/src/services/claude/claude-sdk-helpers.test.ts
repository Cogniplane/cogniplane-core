import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { test, expect, describe, afterEach } from "vitest";

import { phase4RuntimePolicy } from "../../test-helpers/phase4-runtime-policy.js";
import {
  buildClaudeContentBlocks,
  buildClaudePromptStream,
  buildClaudeSdkEnv,
  buildClaudeSdkOptions,
  inferImageMediaType,
  isClaudeSdkEnvAllowed,
  isInitMessage,
  resolveSandboxWorkspacePath,
  resolveWorkspacePath
} from "./claude-sdk-helpers.js";

describe("inferImageMediaType", () => {
  test.each([
    [".jpg", "image/jpeg"],
    [".jpeg", "image/jpeg"],
    [".JPG", "image/jpeg"],
    [".gif", "image/gif"],
    [".webp", "image/webp"],
    [".png", "image/png"],
    [".unknown", "image/png"], // default fallback
    ["", "image/png"]
  ])("'%s' -> '%s'", (ext, expected) => {
    expect(inferImageMediaType(`/tmp/test${ext}`)).toBe(expected);
  });
});

describe("resolveWorkspacePath", () => {
  test("resolves a relative path inside the workspace", () => {
    const ws = "/tmp/workspace";
    const resolved = resolveWorkspacePath(ws, "subdir/file.txt");
    expect(resolved).toBe(path.resolve(ws, "subdir/file.txt"));
  });

  test("allows the workspace root itself (e.g., '.')", () => {
    const ws = "/tmp/workspace";
    expect(resolveWorkspacePath(ws, ".")).toBe(path.resolve(ws));
  });

  test("rejects directory traversal escaping the workspace", () => {
    expect(() => resolveWorkspacePath("/tmp/workspace", "../etc/passwd")).toThrow(
      /must be inside the session workspace/
    );
  });

  test("rejects absolute paths outside the workspace", () => {
    expect(() => resolveWorkspacePath("/tmp/workspace", "/etc/passwd")).toThrow(
      /must be inside the session workspace/
    );
  });

  test("handles workspace paths that already end with separator", () => {
    const ws = "/tmp/workspace/";
    expect(resolveWorkspacePath(ws, "file.txt")).toBe(path.resolve(ws, "file.txt"));
  });
});

describe("resolveSandboxWorkspacePath", () => {
  test("resolves relative paths under sandbox root", () => {
    const sandbox = "/home/user/workspace/sess-1";
    expect(resolveSandboxWorkspacePath(sandbox, "out.txt")).toBe(
      "/home/user/workspace/sess-1/out.txt"
    );
  });

  test("normalizes nested paths", () => {
    const sandbox = "/home/user/workspace/sess-1";
    expect(resolveSandboxWorkspacePath(sandbox, "a/b/../c/d.md")).toBe(
      "/home/user/workspace/sess-1/a/c/d.md"
    );
  });

  test("rejects traversal that escapes the sandbox", () => {
    expect(() =>
      resolveSandboxWorkspacePath("/home/user/workspace/sess-1", "../../etc/passwd")
    ).toThrow(/must be inside the session workspace/);
  });

  test("allows the sandbox root itself", () => {
    const sandbox = "/home/user/workspace/sess-1";
    expect(resolveSandboxWorkspacePath(sandbox, ".")).toBe(sandbox);
  });

  test("uses POSIX semantics regardless of host OS", () => {
    // On Windows, path.resolve would default to backslash. We force POSIX
    // because sandbox paths are always Linux.
    expect(resolveSandboxWorkspacePath("/home/u/ws", "x/y.txt")).toContain("/");
    expect(resolveSandboxWorkspacePath("/home/u/ws", "x/y.txt")).not.toContain("\\");
  });
});

describe("isInitMessage", () => {
  test("returns true for an init system message", () => {
    expect(isInitMessage({ type: "system", subtype: "init" })).toBe(true);
  });

  test("returns false for non-init system messages", () => {
    expect(isInitMessage({ type: "system", subtype: "warning" })).toBe(false);
  });

  test("returns false for non-system messages", () => {
    expect(isInitMessage({ type: "assistant" })).toBe(false);
  });

  test("returns false for non-objects", () => {
    expect(isInitMessage(null)).toBe(false);
    expect(isInitMessage(undefined)).toBe(false);
    expect(isInitMessage("init")).toBe(false);
    expect(isInitMessage(42)).toBe(false);
  });
});

describe("buildClaudeSdkEnv", () => {
  const ORIGINAL_ENV = { ...process.env };
  afterEach(() => {
    // Restore env so polluted keys don't leak between tests
    for (const k of Object.keys(process.env)) {
      if (!(k in ORIGINAL_ENV)) delete process.env[k];
    }
    Object.assign(process.env, ORIGINAL_ENV);
  });

  // Every secret-bearing env var the backend reads (mirrors config.ts). The
  // allowlist is fail-closed, so this list does not need to be exhaustive for
  // the security property to hold — but it documents the concrete keys we know
  // carry secrets, including NOTION_OAUTH_CLIENT_SECRET, which the previous
  // denylist leaked to the agent. The marker value lets us assert by VALUE
  // (not just key name) that nothing secret survives.
  const SECRET_CONFIG_KEYS = [
    "DATABASE_URL",
    "MIGRATION_DATABASE_URL",
    "JWT_SECRET",
    "DATA_ENCRYPTION_SECRET",
    "WORKOS_API_KEY",
    "WORKOS_CLIENT_ID",
    "WORKOS_CLIENT_SECRET",
    "GITHUB_OAUTH_CLIENT_ID",
    "GITHUB_OAUTH_CLIENT_SECRET",
    "NOTION_OAUTH_CLIENT_ID",
    "NOTION_OAUTH_CLIENT_SECRET",
    "PII_OPENROUTER_API_KEY",
    "PII_RETENTION_KEK",
    "E2B_API_KEY",
    "ARTIFACT_BUCKET_ACCESS_KEY_ID",
    "ARTIFACT_BUCKET_SECRET_ACCESS_KEY",
    "ARTIFACT_BUCKET_SESSION_TOKEN",
    "OPENAI_API_KEY",
    "REDIS_URL",
    // Anthropic credential-bearing vars: a bearer/OAuth token and a header bag
    // that can carry `Authorization:`. Auth is set explicitly (rt_* proxy token
    // or fallback key), so these must never be inherited into the sandbox.
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_CUSTOM_HEADERS"
  ];

  test("no secret-bearing config key survives the allowlist", () => {
    const SECRET_MARKER = "SECRET-MUST-NOT-LEAK";
    for (const key of SECRET_CONFIG_KEYS) {
      process.env[key] = SECRET_MARKER;
    }
    // An allowlisted SDK knob must still pass through.
    process.env.HTTPS_PROXY = "http://proxy.corp:8080";
    process.env.HARMLESS_NON_ALLOWED = "kept?";

    const env = buildClaudeSdkEnv("test-key");

    // Belt: no secret key name leaks.
    for (const key of SECRET_CONFIG_KEYS) {
      expect(env[key], `secret key "${key}" leaked into SDK env`).toBeUndefined();
    }
    // Suspenders: the marker value does not appear under ANY key (catches a
    // secret that slipped through under an alias or prefix match).
    for (const [key, value] of Object.entries(env)) {
      expect(value, `marker leaked via key "${key}"`).not.toBe(SECRET_MARKER);
    }
    // Allowlisted essentials survive.
    expect(env.HTTPS_PROXY).toBe("http://proxy.corp:8080");
    expect(env.ANTHROPIC_API_KEY).toBe("test-key");
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    // A non-allowlisted, non-secret var is also dropped (fail-closed default).
    expect(env.HARMLESS_NON_ALLOWED).toBeUndefined();
  });

  test("inherited ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL are not passed through implicitly", () => {
    // These are set explicitly by buildClaudeSdkEnv (proxy token or fallback),
    // never inherited from the backend process — so an inherited backend key
    // must not survive the filter on its own.
    process.env.ANTHROPIC_API_KEY = "inherited-backend-key";
    process.env.ANTHROPIC_BASE_URL = "https://inherited.example";

    // null key + no proxy → ANTHROPIC_API_KEY is deleted, base URL not echoed.
    const env = buildClaudeSdkEnv(null);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  test("allowlist keeps SDK / proxy knobs and drops backend OS-environment vars", () => {
    process.env.HTTPS_PROXY = "http://proxy.corp:8080";
    process.env.NODE_EXTRA_CA_CERTS = "/etc/ssl/corp.pem";
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    // OS-baseline vars from the backend container must NOT be forwarded — the
    // E2B sandbox supplies its own correct values. Forwarding HOME=/home/appuser
    // broke the spawned `claude` CLI's init ("Query closed before response").
    process.env.HOME = "/home/appuser";
    process.env.PATH = "/backend/only/bin";
    process.env.NODE_PATH = "/backend/node_modules";
    process.env.SOME_RANDOM_BACKEND_VAR = "nope";

    const env = buildClaudeSdkEnv("k");

    expect(env.HTTPS_PROXY).toBe("http://proxy.corp:8080");
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/etc/ssl/corp.pem");
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
    expect(env.HOME).toBeUndefined();
    expect(env.PATH).toBeUndefined();
    expect(env.NODE_PATH).toBeUndefined();
    expect(env.SOME_RANDOM_BACKEND_VAR).toBeUndefined();
  });

  test("isClaudeSdkEnvAllowed: exact names, prefixes, and rejections", () => {
    expect(isClaudeSdkEnvAllowed("HTTPS_PROXY")).toBe(true);
    expect(isClaudeSdkEnvAllowed("NODE_OPTIONS")).toBe(true);
    expect(isClaudeSdkEnvAllowed("CLAUDE_CODE_ANYTHING_NEW")).toBe(true);
    expect(isClaudeSdkEnvAllowed("LC_ALL")).toBe(true);
    // OS-baseline vars are intentionally dropped (sandbox supplies its own).
    expect(isClaudeSdkEnvAllowed("HOME")).toBe(false);
    expect(isClaudeSdkEnvAllowed("PATH")).toBe(false);
    expect(isClaudeSdkEnvAllowed("NODE_PATH")).toBe(false);
    expect(isClaudeSdkEnvAllowed("NOTION_OAUTH_CLIENT_SECRET")).toBe(false);
    expect(isClaudeSdkEnvAllowed("DATABASE_URL")).toBe(false);
    // ANTHROPIC_API_KEY is set explicitly, not inherited — not on the allowlist.
    expect(isClaudeSdkEnvAllowed("ANTHROPIC_API_KEY")).toBe(false);
  });

  test("deletes inherited ANTHROPIC_API_KEY when null is passed", () => {
    process.env.ANTHROPIC_API_KEY = "inherited-key";
    const env = buildClaudeSdkEnv(null);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test("forces CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 even when not set in process.env", () => {
    delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
    const env = buildClaudeSdkEnv("k");
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
  });

  test("proxy mode injects rt_* + base URL and never the real key", () => {
    process.env.ANTHROPIC_API_KEY = "inherited-key";
    const env = buildClaudeSdkEnv("sk-ant-real-tenant-key", {
      runtimeToken: "rt_session_token_value",
      baseUrl: "https://backend.example/llm/anthropic"
    });
    expect(env.ANTHROPIC_API_KEY).toBe("rt_session_token_value");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://backend.example/llm/anthropic");
    // The real key passed as the first arg must NOT appear anywhere in the env
    // — the whole point of e2b proxy mode is that the sandbox never sees it.
    for (const value of Object.values(env)) {
      expect(value).not.toBe("sk-ant-real-tenant-key");
    }
  });

  test("proxy mode wins over a missing real key (rt_ still injected)", () => {
    const env = buildClaudeSdkEnv(null, {
      runtimeToken: "rt_only",
      baseUrl: "https://backend.example/llm/anthropic"
    });
    expect(env.ANTHROPIC_API_KEY).toBe("rt_only");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://backend.example/llm/anthropic");
  });

  test("no-proxy fallback leaves real key in env and no base URL override", () => {
    const env = buildClaudeSdkEnv("sk-ant-real");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-real");
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });
});

describe("buildClaudeSdkOptions", () => {
  const baseInput = {
    model: "claude-sonnet-4-6",
    developerInstructions: null,
    mcpServersConfig: {},
    workspacePath: "/tmp/ws",
    env: {},
    canUseTool: (async () => ({ behavior: "allow", updatedInput: {} })) as never
  };

  test("default systemPrompt uses the claude_code preset without append", () => {
    const opts = buildClaudeSdkOptions(baseInput);
    expect(opts.systemPrompt).toEqual({ type: "preset", preset: "claude_code" });
    expect(opts.permissionMode).toBe("default");
    expect(opts.includePartialMessages).toBe(true);
    expect(opts.maxTurns).toBe(100);
  });

  test("appends developerInstructions to systemPrompt when present", () => {
    const opts = buildClaudeSdkOptions({
      ...baseInput,
      developerInstructions: "be helpful"
    });
    expect(opts.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "be helpful"
    });
  });

  test("attaches MCP servers only when at least one is present", () => {
    expect(buildClaudeSdkOptions(baseInput).mcpServers).toBeUndefined();

    const withMcp = buildClaudeSdkOptions({
      ...baseInput,
      mcpServersConfig: {
        github: { type: "http", url: "https://api/mcp/github", headers: {} }
      }
    });
    expect(withMcp.mcpServers).toBeDefined();
  });

  test("passes effort + adaptive thinking when effort is set", () => {
    const opts = buildClaudeSdkOptions({ ...baseInput, effort: "medium" });
    // The SDK options object will contain `thinking` and `effort` only when input.effort truthy
    expect((opts as Record<string, unknown>).thinking).toEqual({ type: "adaptive" });
    expect((opts as Record<string, unknown>).effort).toBe("medium");
  });

  test("omits effort + thinking when effort is not set", () => {
    const opts = buildClaudeSdkOptions(baseInput);
    expect((opts as Record<string, unknown>).thinking).toBeUndefined();
    expect((opts as Record<string, unknown>).effort).toBeUndefined();
  });
});

describe("buildClaudeContentBlocks", () => {
  let tmpDir: string;
  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  test("emits a single text block when no userInputs are supplied", async () => {
    const blocks = await buildClaudeContentBlocks({
      prompt: "hello",
      runtimePolicy: phase4RuntimePolicy,
      toolContextId: null
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("text");
    // Without an MCP server enabled OR no toolContextId, prompt is unchanged.
    // phase4RuntimePolicy has 1 enabledMcpServers but toolContextId is null →
    // unchanged.
    expect(blocks[0]?.text).toBe("hello");
  });

  test("prepends framework turn context when both MCP server enabled AND toolContextId present", async () => {
    const blocks = await buildClaudeContentBlocks({
      prompt: "do thing",
      runtimePolicy: phase4RuntimePolicy,
      toolContextId: "ctx-abc"
    });
    expect(blocks).toHaveLength(1);
    const text = blocks[0]?.text as string;
    expect(text).toContain("Framework turn context:");
    expect(text).toContain("ctx-abc");
    expect(text).toMatch(/do thing$/);
  });

  test("renders an image URL entry as a text block describing the URL", async () => {
    const blocks = await buildClaudeContentBlocks({
      prompt: "see image",
      userInputs: [{ type: "image", url: "https://cdn.example/cat.png" }],
      runtimePolicy: phase4RuntimePolicy,
      toolContextId: null
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("text");
    expect(blocks[0]?.text).toContain("https://cdn.example/cat.png");
  });

  test("base64-encodes a local image with the inferred media type", async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "claude-helpers-test-"));
    const imgPath = path.join(tmpDir, "tiny.png");
    const expectedBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
    await writeFile(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const blocks = await buildClaudeContentBlocks({
      prompt: "see image",
      userInputs: [
        { type: "text", text: "describe" },
        { type: "localImage", path: imgPath }
      ],
      runtimePolicy: phase4RuntimePolicy,
      toolContextId: null
    });
    expect(blocks).toHaveLength(2);
    expect(blocks[1]?.type).toBe("image");
    const source = blocks[1]?.source as Record<string, unknown>;
    expect(source.type).toBe("base64");
    expect(source.media_type).toBe("image/png");
    expect(source.data).toBe(expectedBase64);
  });
});

describe("buildClaudePromptStream", () => {
  test("yields exactly one user message with text content for the session", async () => {
    const iter = buildClaudePromptStream({
      prompt: "hello world",
      runtimePolicy: phase4RuntimePolicy,
      toolContextId: null,
      sessionId: "sess-1"
    });
    const messages: unknown[] = [];
    for await (const msg of iter) {
      messages.push(msg);
    }
    expect(messages).toHaveLength(1);
    const m = messages[0] as {
      type: string;
      session_id: string;
      parent_tool_use_id: null;
      message: { role: string; content: Array<Record<string, unknown>> };
    };
    expect(m.type).toBe("user");
    expect(m.session_id).toBe("sess-1");
    expect(m.parent_tool_use_id).toBeNull();
    expect(m.message.role).toBe("user");
    expect(m.message.content[0]?.type).toBe("text");
    expect(m.message.content[0]?.text).toBe("hello world");
  });
});
