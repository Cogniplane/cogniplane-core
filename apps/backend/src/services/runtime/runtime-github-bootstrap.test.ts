import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, onTestFinished } from "vitest";

import { prepareGithubWorkspace } from "./runtime-github-bootstrap.js";

const baseCreds = {
  token: "ghu_secret",
  login: "octocat",
  name: "Octo Cat",
  email: "octo@example.com"
};

test("prepareGithubWorkspace writes a credential helper and gitconfig under .sandbox/github", async () => {
  const ws = await mkdtemp(path.join(tmpdir(), "gh-bootstrap-"));
  onTestFinished(() => rm(ws, { recursive: true, force: true }));

  const env = await prepareGithubWorkspace(ws, baseCreds);

  // Helper script exists, is executable, and is referenced by env.GIT_CONFIG_GLOBAL.
  const helperPath = path.join(ws, ".sandbox", "github", "git-credential-helper.sh");
  const helperStat = await stat(helperPath);
  expect(helperStat.mode & 0o100).toBeTruthy();

  const gitConfigPath = env.GIT_CONFIG_GLOBAL;
  const config = await readFile(gitConfigPath, "utf8");
  expect(config).toMatch(/\[credential\]/);
  expect(config).toMatch(/helper = "/);
  expect(config).toMatch(/useHttpPath = true/);
  expect(config).toMatch(/\[user\]/);
  expect(config).toMatch(/name = Octo Cat/);
  expect(config).toMatch(/email = octo@example.com/);

  expect(env.EAF_GITHUB_TOKEN).toBe("ghu_secret");
  expect(env.GITHUB_TOKEN).toBe("ghu_secret");
  expect(env.GH_TOKEN).toBe("ghu_secret");
  expect(env.GH_PROMPT_DISABLED).toBe("1");
});

test("prepareGithubWorkspace falls back to login when no name", async () => {
  const ws = await mkdtemp(path.join(tmpdir(), "gh-bootstrap-"));
  onTestFinished(() => rm(ws, { recursive: true, force: true }));
  const env = await prepareGithubWorkspace(ws, {
    ...baseCreds,
    name: null,
    email: null
  });
  const config = await readFile(env.GIT_CONFIG_GLOBAL, "utf8");
  expect(config).toMatch(/name = octocat/);
  // No email line emitted
  expect(config).not.toMatch(/^\temail =/m);
});

test("prepareGithubWorkspace omits [user] section when login and name are absent", async () => {
  const ws = await mkdtemp(path.join(tmpdir(), "gh-bootstrap-"));
  onTestFinished(() => rm(ws, { recursive: true, force: true }));
  const env = await prepareGithubWorkspace(ws, {
    token: "ghu_x",
    login: null,
    name: null,
    email: "ignored@example.com"
  });
  const config = await readFile(env.GIT_CONFIG_GLOBAL, "utf8");
  expect(config).not.toMatch(/\[user\]/);
});

test("prepareGithubWorkspace escapes backslash and quotes in helper path", async () => {
  // Pick a workspace whose path contains a quote so the path needs escaping
  const ws = await mkdtemp(path.join(tmpdir(), 'gh"bootstrap-'));
  onTestFinished(() => rm(ws, { recursive: true, force: true }));

  const env = await prepareGithubWorkspace(ws, baseCreds);
  const config = await readFile(env.GIT_CONFIG_GLOBAL, "utf8");
  // The quote in the path is escaped — the helper line still has matching outer quotes.
  expect(config).toMatch(/helper = "[^"]*\\"/);
});
