import { afterEach, beforeEach, describe, expect, test } from "vitest";

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
  // The list is stored in lower case. Requests keep the case that the model sent.
  allowedRepositories: ["owner/repo", "octocat/hello-world"]
};

let currentCreds: typeof fakeCreds | null = fakeCreds;

const deps = {
  githubConnections: {
    async getRuntimeCredentials() {
      return currentCreds;
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

function installFakeFetch(responseBody: Record<string, unknown> = {}) {
  fake = createFakeFetch(() => Response.json(responseBody));
}

beforeEach(() => {
  fake = null;
  currentCreds = fakeCreds;
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

test("github_read_file reports a directory path as an error with its entries", async () => {
  fake = createFakeFetch(() => Response.json([
    { type: "file", path: "src/a.ts" },
    { type: "dir", path: "src/lib" }
  ]));
  const result = await readTool!.handler({
    context: fakeContext,
    arguments: { repo: "octocat/Hello-World", path: "src" }
  });
  expect(result).toEqual({
    error: "The path is a directory. Read one of its files instead.",
    detail: { entries: ["src/a.ts", "src/lib"] }
  });
});

test("github_read_file reports a non-file entry as an error", async () => {
  installFakeFetch({ type: "submodule", path: "vendor/lib", sha: "s" });
  const result = await readTool!.handler({
    context: fakeContext,
    arguments: { repo: "octocat/Hello-World", path: "vendor/lib" }
  });
  expect(result).toEqual({ error: "The path is a submodule, not a file." });
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

test("github tools pass the account the turn recorded to the credential lookup", async () => {
  const expected: unknown[] = [];
  const [read] = createGithubTools({
    githubConnections: {
      async getRuntimeCredentials(_tenantId: string, _userId: string, expectedAccountId?: string | null) {
        expected.push(expectedAccountId);
        return null;
      }
    }
  });
  await read!.handler({ context: { ...fakeContext, metadata: { integrationAccounts: { github: "gh-1" } } },
    arguments: { repo: "octocat/Hello-World", path: "a.ts" } });
  await read!.handler({ context: { ...fakeContext, metadata: { integrationAccounts: {} } },
    arguments: { repo: "octocat/Hello-World", path: "a.ts" } });
  await read!.handler({ context: fakeContext, arguments: { repo: "octocat/Hello-World", path: "a.ts" } });

  expect(expected).toEqual(["gh-1", null, undefined]);
});

// ── repository allowlist ─────────────────────────────────────────────────────
//
// The user's allowed-repository list narrows what the agent can reach. Every
// tool must apply it before the GitHub API call. The cases below run each tool
// so a new tool that skips the gate fails here.

const writeArgs = (repo: string) => ({ repo, path: "README.md", branch: "main", content: "x", message: "m" });
const toolCalls: Array<{ name: string; tool: () => NonNullable<typeof readTool>; args: (repo: string) => Record<string, unknown> }> = [
  { name: "github_read_file", tool: () => readTool!, args: (repo) => ({ repo, path: "README.md" }) },
  { name: "github_write_file", tool: () => writeTool!, args: writeArgs },
  { name: "github_create_pr", tool: () => prTool!, args: (repo) => ({ repo, title: "t", head: "feature", base: "main" }) }
];

describe.each(toolCalls)("$name repository allowlist", ({ tool, args }) => {
  const call = (repo: string) => tool().handler({ context: fakeContext, arguments: args(repo) });

  test("denies every repository while the list is empty", async () => {
    installFakeFetch();
    currentCreds = { ...fakeCreds, allowedRepositories: [] };
    const result = await call("owner/repo");
    expect(String(result.error)).toMatch(/has not allowed the agent to use any GitHub repository/);
    expect(String(result.error)).toMatch(/Settings > GitHub/);
    expect(capturedUrl()).toBe(null);
  });

  test("denies a repository that is not on the list, also with the same owner or name", async () => {
    installFakeFetch();
    for (const repo of ["owner/other", "other/repo", "owner/repo-2", "owner/repo.git", "owner/rep0"]) {
      const result = await call(repo);
      expect(String(result.error)).toMatch(/not on the user's list of allowed GitHub repositories/);
      expect(String(result.error)).toContain(repo.toLowerCase());
      expect(capturedUrl()).toBe(null);
    }
  });

  test("does not let a repository value that is not a plain owner/name reach the list check", async () => {
    installFakeFetch();
    for (const repo of [
      " owner/repo", "owner/repo ", "owner/repo/", "owner/repo/contents/x", "owner/repo?x=1",
      "owner/repo#x", "owner\\repo", "owner/rеpo" /* Cyrillic е */, "owner/repo%2F..", "..", "owner/.."
    ]) {
      const result = await call(repo);
      expect(String(result.error), repo).toMatch(/Invalid repo/);
      expect(capturedUrl(), repo).toBe(null);
    }
  });

  test("takes the list from the connection, never from the arguments", async () => {
    installFakeFetch();
    const result = await tool().handler({
      context: fakeContext,
      arguments: { ...args("evil/repo"), allowedRepositories: ["evil/repo"], allowed: ["evil/repo"] }
    });
    expect(String(result.error)).toMatch(/not on the user's list/);
    expect(capturedUrl()).toBe(null);
  });

  test("keeps the credential failure answer when no usable connection exists, whatever the list says", async () => {
    installFakeFetch();
    currentCreds = null;
    const result = await call("owner/other");
    expect(result).toEqual({ error: "No GitHub connection found. Connect your GitHub account in settings." });
    expect(capturedUrl()).toBe(null);
  });

  test("keeps the credential error of the connection service", async () => {
    installFakeFetch();
    const failing = createGithubTools({
      githubConnections: { async getRuntimeCredentials() { throw new Error("GitHub account changed"); } }
    }).find((t) => t.name === tool().name)!;
    await expect(failing.handler({ context: fakeContext, arguments: args("owner/other") })).rejects.toThrow(
      "GitHub account changed"
    );
    expect(capturedUrl()).toBe(null);
  });

  test("keeps the GitHub error for an allowed repository when GitHub rejects the token", async () => {
    fake = createFakeFetch(() => Response.json({ message: "Bad credentials" }, { status: 401 }));
    const result = await call("owner/repo");
    expect(result).toEqual({ error: "GitHub API error 401", detail: { message: "Bad credentials" } });
  });

  test("stops at a redirect instead of following a renamed or transferred repository", async () => {
    fake = createFakeFetch(() => new Response(JSON.stringify({ message: "Moved Permanently" }), {
      status: 301,
      headers: { location: "https://api.github.com/repositories/1/contents/README.md" }
    }));
    const result = await call("owner/repo");
    expect(String(result.error)).toMatch(/renamed or transferred/);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.init.redirect).toBe("manual");
  });
});

test("allowed repositories match without regard to case and keep the case that the model sent", async () => {
  installFakeFetch({ path: "p", sha: "s", size: 0, content: "" });
  currentCreds = { ...fakeCreds, allowedRepositories: ["acme/web-app"] };

  await readTool!.handler({ context: fakeContext, arguments: { repo: "ACME/Web-App", path: "a.txt" } });
  expect(capturedUrl()).toBe("https://api.github.com/repos/ACME/Web-App/contents/a.txt");

  await readTool!.handler({ context: fakeContext, arguments: { repo: "acme/web-app", path: "a.txt" } });
  expect(capturedUrl()).toBe("https://api.github.com/repos/acme/web-app/contents/a.txt");
});

test("an allowed read returns the file, with the user's token and no redirect following", async () => {
  fake = createFakeFetch(() => Response.json({
    type: "file", path: "README.md", sha: "abc", size: 5, encoding: "base64",
    content: Buffer.from("hello").toString("base64")
  }));
  const result = await readTool!.handler({ context: fakeContext, arguments: { repo: "owner/repo", path: "README.md" } });

  expect(result).toEqual({ path: "README.md", sha: "abc", size: 5, content: "hello" });
  const init = fake.calls[0]!.init;
  expect((init.headers as Record<string, string>).Authorization).toBe("Bearer ghp_faketoken");
  expect(init.redirect).toBe("manual");
});

test("an allowed write sends the commit to the allowed repository", async () => {
  fake = createFakeFetch(() => Response.json({
    content: { path: "README.md", sha: "new" },
    commit: { sha: "c1", html_url: "https://github.com/owner/repo/commit/c1", committer: { name: "Octocat" } }
  }));
  const result = await writeTool!.handler({ context: fakeContext, arguments: writeArgs("Owner/Repo") });

  expect(result).toMatchObject({ path: "README.md", sha: "new", commitSha: "c1" });
  const call = fake.calls[0]!;
  expect(call.url).toBe("https://api.github.com/repos/Owner/Repo/contents/README.md");
  expect(call.init.method).toBe("PUT");
  expect(JSON.parse(String(call.init.body))).toMatchObject({ branch: "main", message: "m" });
});

test("an allowed pull request opens in the allowed repository", async () => {
  fake = createFakeFetch(() => Response.json({
    number: 7, html_url: "u", state: "open", title: "t", head: { ref: "feature" }, base: { ref: "main" }, draft: false
  }));
  const result = await prTool!.handler({
    context: fakeContext,
    arguments: { repo: "owner/repo", title: "t", head: "feature", base: "main" }
  });

  expect(result).toMatchObject({ number: 7, head: "feature", base: "main" });
  expect(fake.calls[0]!.url).toBe("https://api.github.com/repos/owner/repo/pulls");
});

test("a pull request cannot take its branch from a repository that the list does not cover", async () => {
  installFakeFetch({ number: 1, html_url: "u", state: "open", title: "t", head: { ref: "h" }, base: { ref: "b" }, draft: false });
  const open = (head: string) =>
    prTool!.handler({ context: fakeContext, arguments: { repo: "owner/repo", title: "t", head, base: "main" } });

  // Another owner's fork, or a fork named with owner/repo, is a second repository.
  for (const head of ["attacker:feature", "attacker/repo:feature", ":feature"]) {
    const denied = await open(head);
    expect(String(denied.error), head).toMatch(/Invalid head/);
    expect(capturedUrl(), head).toBe(null);
  }

  // The owner of the allowed repository is the repository itself.
  await open("Owner:feature");
  expect(capturedUrl()).toBe("https://api.github.com/repos/owner/repo/pulls");
});

test("the tool set has no tool that lists or searches repositories", () => {
  // A tool that returns repositories outside the allowed list leaks their names
  // and content. Add the filter and a test for it before adding such a tool.
  expect(tools.map((t) => t.name).sort()).toEqual(["github_create_pr", "github_read_file", "github_write_file"]);
  for (const tool of tools) {
    expect(Object.keys(tool.inputSchema.properties as Record<string, unknown>)).not.toContain("allowedRepositories");
  }
});
