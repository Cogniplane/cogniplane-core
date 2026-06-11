import { test, afterEach, beforeEach, expect } from "vitest";

import type { ToolExecutionContext } from "../auth/tool-execution-context-store.js";
import { createFakeFetch, type FakeFetch } from "../../test-helpers/fake-fetch.js";
import { createGithubTools, GITHUB_TOOL_CATALOG } from "./github-tools.js";

const fakeContext: ToolExecutionContext = {
  toolContextId: "ctx-1",
  tenantId: "tenant-1",
  sessionId: "session-1",
  userId: "user-1",
  runtimeId: "runtime-1",
  runtimePolicyId: "default",
  messageId: null,
  credentialEnvelope: {},
  metadata: {},
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  createdAt: new Date().toISOString()
};

const fakeCreds = {
  login: "octocat",
  name: "Octocat",
  email: "octo@example.com",
  token: "ghp_faketoken",
  source: "user" as const
};

const deps = {
  githubConnections: {
    async getRuntimeCredentials() {
      return fakeCreds;
    }
  }
};

const tools = createGithubTools(deps);
const readTool = tools.find((t) => t.name === "github_read_file");
const writeTool = tools.find((t) => t.name === "github_write_file");
const prTool = tools.find((t) => t.name === "github_create_pr");
expect(readTool && writeTool && prTool).toBeTruthy();

let fake: FakeFetch | null = null;

// The URL of the last fetch the tool issued, or null when validation rejected
// before any fetch (the only observable signal that the canonical URL was
// constructed vs. short-circuited).
function capturedUrl(): string | null {
  const calls = fake?.calls ?? [];
  return calls.length > 0 ? calls[calls.length - 1]!.url : null;
}

function installFakeFetch(responseBody: Record<string, unknown> = {}, ok = true, status = 200) {
  fake = createFakeFetch(
    () =>
      ({
        ok,
        status,
        async json() {
          return responseBody;
        },
        async text() {
          return JSON.stringify(responseBody);
        }
      }) as unknown as Response
  );
}

beforeEach(() => {
  fake = null;
});

afterEach(() => {
  fake?.restore();
  fake = null;
});

// ── github_read_file ─────────────────────────────────────────────────────────

test("github_read_file rejects malformed repo with extra path segments", async () => {
  installFakeFetch();
  const result = await readTool!.handler({
    context: fakeContext,
    arguments: { repo: "owner/repo/contents/secret", path: "README.md" }
  });
  expect(String(result.error ?? "")).toMatch(/Invalid repo/i);
  expect(capturedUrl()).toBe(null);
});

test("github_read_file rejects a repo with a dot-dot segment that survives the regex", async () => {
  // "../user" has a single slash, so REPO_PATTERN matches (the character
  // class allows all-dot segments). Without the explicit dot-segment guard
  // the URL parser would resolve ".." and pivot to /user under the PAT.
  installFakeFetch();
  for (const repo of ["../user", "owner/..", "..", "owner/."]) {
    const result = await readTool!.handler({
      context: fakeContext,
      arguments: { repo, path: "README.md" }
    });
    expect(String(result.error ?? "")).toMatch(/Invalid repo/i);
    expect(capturedUrl()).toBe(null);
  }
});

test("github_read_file rejects repo containing query string", async () => {
  installFakeFetch();
  const result = await readTool!.handler({
    context: fakeContext,
    arguments: { repo: "owner/repo?ref=evil", path: "README.md" }
  });
  expect(String(result.error ?? "")).toMatch(/Invalid repo/i);
  expect(capturedUrl()).toBe(null);
});

test("github_read_file rejects path containing '..' segments", async () => {
  installFakeFetch();
  const result = await readTool!.handler({
    context: fakeContext,
    arguments: { repo: "owner/repo", path: "docs/../../etc/secret" }
  });
  expect(String(result.error ?? "")).toMatch(/Invalid path/i);
  expect(capturedUrl()).toBe(null);
});

test("github_read_file encodes path segments containing reserved characters", async () => {
  installFakeFetch({ path: "p", sha: "s", size: 0, content: "" });
  await readTool!.handler({
    context: fakeContext,
    arguments: { repo: "owner/repo", path: "dir/file with space.txt" }
  });
  expect(capturedUrl()).toBeTruthy();
  expect(capturedUrl()!).toMatch(/\/contents\/dir\/file%20with%20space\.txt$/);
});

test("github_read_file constructs the canonical URL on valid input", async () => {
  installFakeFetch({ path: "p", sha: "s", size: 0, content: "" });
  await readTool!.handler({
    context: fakeContext,
    arguments: { repo: "octocat/Hello-World", path: "src/index.ts", ref: "main" }
  });
  expect(capturedUrl()).toBe("https://api.github.com/repos/octocat/Hello-World/contents/src/index.ts?ref=main");
});

// ── github_write_file ────────────────────────────────────────────────────────

test("github_write_file rejects malformed repo", async () => {
  installFakeFetch();
  const result = await writeTool!.handler({
    context: fakeContext,
    arguments: {
      repo: "../etc/passwd",
      path: "README.md",
      branch: "main",
      content: "x",
      message: "test"
    }
  });
  expect(String(result.error ?? "")).toMatch(/Invalid repo/i);
  expect(capturedUrl()).toBe(null);
});

test("github_write_file rejects path with '..' segments", async () => {
  installFakeFetch();
  const result = await writeTool!.handler({
    context: fakeContext,
    arguments: {
      repo: "owner/repo",
      path: "../../../etc/passwd",
      branch: "main",
      content: "x",
      message: "test"
    }
  });
  expect(String(result.error ?? "")).toMatch(/Invalid path/i);
  expect(capturedUrl()).toBe(null);
});

// ── github_create_pr ─────────────────────────────────────────────────────────

test("github_create_pr rejects malformed repo", async () => {
  installFakeFetch();
  const result = await prTool!.handler({
    context: fakeContext,
    arguments: {
      repo: "owner/repo/pulls/1",
      title: "Test",
      head: "feature",
      base: "main"
    }
  });
  expect(String(result.error ?? "")).toMatch(/Invalid repo/i);
  expect(capturedUrl()).toBe(null);
});

test("github_create_pr constructs canonical URL on valid input", async () => {
  installFakeFetch({ number: 1, html_url: "u", state: "open", title: "t", head: { ref: "h" }, base: { ref: "b" }, draft: false });
  await prTool!.handler({
    context: fakeContext,
    arguments: { repo: "octocat/Hello-World", title: "t", head: "h", base: "b" }
  });
  expect(capturedUrl()).toBe("https://api.github.com/repos/octocat/Hello-World/pulls");
});

// ── catalog sanity ───────────────────────────────────────────────────────────

test("GITHUB_TOOL_CATALOG entries match created tool names", () => {
  const catalogNames = GITHUB_TOOL_CATALOG.map((c) => c.name).sort();
  const toolNames = tools.map((t) => t.name).sort();
  expect(toolNames).toEqual(catalogNames);
});
