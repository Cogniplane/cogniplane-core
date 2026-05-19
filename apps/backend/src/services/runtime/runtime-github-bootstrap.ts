import path from "node:path";
import { chmod, mkdir, writeFile } from "node:fs/promises";

import type { GithubRuntimeCredentials } from "../integrations/github/github-connection-service.js";

function escapeGitConfigValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

export async function prepareGithubWorkspace(
  workspacePath: string,
  credentials: GithubRuntimeCredentials
): Promise<Record<string, string>> {
  const githubRoot = path.join(workspacePath, ".sandbox", "github");
  const helperPath = path.join(githubRoot, "git-credential-helper.sh");
  const gitConfigPath = path.join(githubRoot, "gitconfig");

  await mkdir(githubRoot, { recursive: true });

  await writeFile(
    helperPath,
    [
      "#!/usr/bin/env sh",
      "host=''",
      "protocol=''",
      "while IFS='=' read -r key value; do",
      "  case \"$key\" in",
      "    host) host=\"$value\" ;;",
      "    protocol) protocol=\"$value\" ;;",
      "  esac",
      "done",
      "if [ \"$protocol\" = \"https\" ] && [ \"$host\" = \"github.com\" ] && [ -n \"$EAF_GITHUB_TOKEN\" ]; then",
      "  printf 'username=x-access-token\\n'",
      "  printf 'password=%s\\n' \"$EAF_GITHUB_TOKEN\"",
      "fi",
      "exit 0",
      ""
    ].join("\n"),
    { mode: 0o700 }
  );
  await chmod(helperPath, 0o700);

  const gitConfigLines = [
    "[credential]",
    `\thelper = "${escapeGitConfigValue(helperPath)}"`,
    "\tuseHttpPath = true",
    "[github]",
    "\tuser = github.com"
  ];

  if (credentials.name || credentials.login) {
    gitConfigLines.push("[user]");
    gitConfigLines.push(`\tname = ${credentials.name ?? credentials.login}`);
    if (credentials.email) {
      gitConfigLines.push(`\temail = ${credentials.email}`);
    }
  }

  await writeFile(gitConfigPath, `${gitConfigLines.join("\n")}\n`);

  return {
    EAF_GITHUB_TOKEN: credentials.token,
    GITHUB_TOKEN: credentials.token,
    GH_TOKEN: credentials.token,
    GH_HOST: "github.com",
    GH_PROMPT_DISABLED: "1",
    GIT_CONFIG_GLOBAL: gitConfigPath,
    GIT_TERMINAL_PROMPT: "0"
  };
}
