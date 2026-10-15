import { parseGithubRepositoryName } from "@cogniplane/shared-types";

import { GITHUB_API_URL } from "../integrations/github/github-api-client.js";
import type {
  GithubConnectionService,
  GithubRuntimeCredentials
} from "../integrations/github/github-connection-service.js";
import {
  isRepositoryAllowed,
  repositoryKey
} from "../integrations/github/github-repository-allowlist.js";
import {
  allRequiredObjectSchema,
  genericObjectSchema,
  safeJsonBody,
  strictObjectSchema,
  withManagedToolErrorSchema,
  type ManagedToolDefinition
} from "./types.js";
import { boundIntegrationAccount } from "../integrations/integration-account-binding.js";

type GithubToolDeps = {
  githubConnections: Pick<GithubConnectionService, "getRuntimeCredentials">;
};

// `repo` and `path` are interpolated into the GitHub API URL. The values come
// from LLM-supplied tool arguments, which can be influenced by prompt
// injection in any document or prior message — so they must be validated
// before becoming part of the URL or the agent could pivot to other GitHub
// API endpoints under the user's token (e.g. `/user`, other repos).

function encodeRepoPath(input: string): string | null {
  const trimmed = input.replace(/^\/+/, "");
  if (trimmed.length === 0) return null;
  const segments = trimmed.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return null;
  }
  return segments.map(encodeURIComponent).join("/");
}

// ── Repository gate ──────────────────────────────────────────────────────────
//
// The OAuth token reaches every repository that the user can reach, so the
// user's allowed-repository list narrows what the agent can use. This is the
// one place that applies the list. Every GitHub API call that names a
// repository goes through `authorizeRepository` and then `fetchRepositoryApi`.
// `fetchRepositoryApi` accepts only the value that `authorizeRepository`
// returns, so a tool cannot reach a repository without the check.
// The model cannot change the list: it lives in the user's connection, and
// only the user's settings request writes it.

declare const authorizedRepositoryBrand: unique symbol;
type AuthorizedRepository = {
  readonly owner: string;
  readonly name: string;
  readonly [authorizedRepositoryBrand]: true;
};

const SETTINGS_HINT = "The user can choose repositories in Settings > GitHub.";

function authorizeRepository(
  credentials: Pick<GithubRuntimeCredentials, "allowedRepositories">,
  repoArgument: unknown
): { repo: AuthorizedRepository } | { error: string } {
  const parsed = parseGithubRepositoryName(String(repoArgument));
  if (!parsed) return { error: "Invalid repo. Must match the pattern owner/name." };
  if (credentials.allowedRepositories.length === 0) {
    return {
      error: `The user has not allowed the agent to use any GitHub repository yet. ${SETTINGS_HINT}`
    };
  }
  if (!isRepositoryAllowed(credentials.allowedRepositories, parsed)) {
    return {
      error: `The repository ${repositoryKey(parsed)} is not on the user's list of allowed GitHub repositories. ${SETTINGS_HINT}`
    };
  }
  return { repo: parsed as AuthorizedRepository };
}

function fetchRepositoryApi(
  credentials: Pick<GithubRuntimeCredentials, "token">,
  repo: AuthorizedRepository,
  subPath: string,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {}
): Promise<Response> {
  return fetch(`${GITHUB_API_URL}/repos/${repo.owner}/${repo.name}${subPath}`, {
    method: init.method,
    body: init.body,
    // A renamed or moved repository answers with a redirect to its new
    // location. Following it would leave the repository that the user allowed.
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
    headers: {
      Authorization: `Bearer ${credentials.token}`,
      Accept: "application/vnd.github+json",
      ...init.headers
    }
  });
}

async function githubApiError(res: Response): Promise<{ error: string; detail?: Record<string, unknown> }> {
  if (res.status >= 300 && res.status < 400) {
    return {
      error: `GitHub moved this repository (renamed or transferred). The allowed repository list uses the old name. ${SETTINGS_HINT}`
    };
  }
  return { error: `GitHub API error ${res.status}`, detail: await safeJsonBody(res) };
}

// ── Catalog entries (static metadata consumed by ./catalog) ──────────────────

export const GITHUB_TOOL_CATALOG: ReadonlyArray<{
  name: string;
  description: string;
  readOnly: boolean;
  inputSchema: Record<string, unknown>;
}> = [
  {
    name: "github_read_file",
    description:
      "Read the contents of a file from a GitHub repository using the connected GitHub account. Works only in repositories that the user allowed in Settings > GitHub.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        toolContextId: { type: "string" },
        repo: { type: "string", description: "Full repo name, e.g. org/repo" },
        path: { type: "string", description: "File path within the repo" },
        ref: { type: "string", description: "Branch, tag, or commit SHA (default: repo default branch)" }
      },
      required: ["toolContextId", "repo", "path"],
      additionalProperties: false
    }
  },
  {
    name: "github_write_file",
    description:
      "Create or update a file in a GitHub repository branch using the connected GitHub account. Works only in repositories that the user allowed in Settings > GitHub.",
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: {
        toolContextId: { type: "string" },
        repo: { type: "string", description: "Full repo name, e.g. org/repo" },
        path: { type: "string", description: "File path to create or update" },
        branch: { type: "string", description: "Target branch name" },
        content: { type: "string", description: "Full file content (UTF-8)" },
        message: { type: "string", description: "Commit message" },
        sha: { type: "string", description: "Current file SHA (required when updating an existing file)" }
      },
      required: ["toolContextId", "repo", "path", "branch", "content", "message"],
      additionalProperties: false
    }
  },
  {
    name: "github_create_pr",
    description:
      "Open a pull request in a GitHub repository using the connected GitHub account. Works only in repositories that the user allowed in Settings > GitHub.",
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: {
        toolContextId: { type: "string" },
        repo: { type: "string", description: "Full repo name, e.g. org/repo" },
        title: { type: "string" },
        body: { type: "string" },
        head: { type: "string", description: "Source branch in the same repository (the branch with changes)" },
        base: { type: "string", description: "Target branch (e.g. main)" },
        draft: { type: "boolean", description: "Open as draft PR (default: false)" }
      },
      required: ["toolContextId", "repo", "title", "head", "base"],
      additionalProperties: false
    }
  }
];

// ── Tool definitions ──────────────────────────────────────────────────────────

export function createGithubTools(deps: GithubToolDeps): ManagedToolDefinition[] {
  const tools: ManagedToolDefinition[] = [
    {
      ...GITHUB_TOOL_CATALOG[0], // github_read_file
      outputSchema: withManagedToolErrorSchema(
        allRequiredObjectSchema({
          path: { type: "string" },
          sha: { type: "string" },
          size: { type: "number" },
          content: { type: "string" }
        })
      ),
      handler: async ({ context, arguments: args }) => {
        const creds = await deps.githubConnections.getRuntimeCredentials(context.tenantId, context.userId,
          boundIntegrationAccount(context.metadata, "github"));
        if (!creds) return { error: "No GitHub connection found. Connect your GitHub account in settings." };

        const access = authorizeRepository(creds, args.repo);
        if ("error" in access) return access;
        const encodedPath = encodeRepoPath(String(args.path));
        if (!encodedPath) return { error: "Invalid path. Must not contain '..' segments." };
        const ref = args.ref ? `?ref=${encodeURIComponent(String(args.ref))}` : "";

        const res = await fetchRepositoryApi(creds, access.repo, `/contents/${encodedPath}${ref}`);

        if (!res.ok) return githubApiError(res);

        const body = (await res.json()) as unknown;
        if (Array.isArray(body)) {
          // The contents API returns an array for a directory.
          const entries = body.slice(0, 200).map((entry) => String((entry as Record<string, unknown>)["path"] ?? ""));
          return { error: "The path is a directory. Read one of its files instead.", detail: { entries } };
        }
        const data = body as Record<string, unknown>;
        if (data["type"] !== undefined && data["type"] !== "file") {
          return { error: `The path is a ${String(data["type"])}, not a file.` };
        }
        if (data["encoding"] === "base64") {
          const content = Buffer.from(String(data["content"]).replace(/\n/g, ""), "base64").toString("utf-8");
          return { path: data["path"], sha: data["sha"], size: data["size"], content };
        }
        return { path: data["path"], sha: data["sha"], size: data["size"], content: data["content"] };
      }
    },

    {
      ...GITHUB_TOOL_CATALOG[1], // github_write_file
      outputSchema: withManagedToolErrorSchema(
        strictObjectSchema({
          path: { type: "string" },
          sha: { type: "string" },
          commitSha: { type: "string" },
          commitUrl: { type: "string" },
          committer: genericObjectSchema
        })
      ),
      handler: async ({ context, arguments: args }) => {
        const creds = await deps.githubConnections.getRuntimeCredentials(context.tenantId, context.userId,
          boundIntegrationAccount(context.metadata, "github"));
        if (!creds) return { error: "No GitHub connection found. Connect your GitHub account in settings." };

        const access = authorizeRepository(creds, args.repo);
        if ("error" in access) return access;
        const encodedPath = encodeRepoPath(String(args.path));
        if (!encodedPath) return { error: "Invalid path. Must not contain '..' segments." };
        const content = Buffer.from(String(args.content), "utf-8").toString("base64");
        const body: Record<string, unknown> = {
          message: String(args.message),
          content,
          branch: String(args.branch),
          committer: {
            name: creds.name ?? creds.login,
            email: creds.email ?? `${creds.login}@users.noreply.github.com`
          }
        };
        if (args.sha) body["sha"] = String(args.sha);

        const res = await fetchRepositoryApi(creds, access.repo, `/contents/${encodedPath}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });

        if (!res.ok) return githubApiError(res);
        const data = (await safeJsonBody(res)) as Record<string, Record<string, unknown>>;

        return {
          path: data["content"]?.["path"],
          sha: data["content"]?.["sha"],
          commitSha: data["commit"]?.["sha"],
          commitUrl: data["commit"]?.["html_url"],
          committer: data["commit"]?.["committer"]
        };
      }
    },

    {
      ...GITHUB_TOOL_CATALOG[2], // github_create_pr
      outputSchema: withManagedToolErrorSchema(
        allRequiredObjectSchema({
          number: { type: "number" },
          url: { type: "string" },
          state: { type: "string" },
          title: { type: "string" },
          head: { type: "string" },
          base: { type: "string" },
          draft: { type: "boolean" }
        })
      ),
      handler: async ({ context, arguments: args }) => {
        const creds = await deps.githubConnections.getRuntimeCredentials(context.tenantId, context.userId,
          boundIntegrationAccount(context.metadata, "github"));
        if (!creds) return { error: "No GitHub connection found. Connect your GitHub account in settings." };

        const access = authorizeRepository(creds, args.repo);
        if ("error" in access) return access;
        // `owner:branch` names a branch in a fork. The fork is a second
        // repository that the list does not cover, so only the owner of the
        // allowed repository itself is accepted as a prefix.
        const head = String(args.head);
        const headOwner = head.includes(":") ? head.split(":", 1)[0]! : null;
        if (headOwner !== null && headOwner.toLowerCase() !== access.repo.owner.toLowerCase()) {
          return {
            error: "Invalid head. Use a branch name of the repository, not a branch of another owner's fork."
          };
        }
        const body = {
          title: String(args.title),
          body: args.body ? String(args.body) : "",
          head,
          base: String(args.base),
          draft: args.draft === true
        };

        const res = await fetchRepositoryApi(creds, access.repo, "/pulls", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });

        if (!res.ok) return githubApiError(res);
        const data = await safeJsonBody(res);

        return {
          number: data["number"],
          url: data["html_url"],
          state: data["state"],
          title: data["title"],
          head: (data["head"] as Record<string, unknown> | undefined)?.["ref"],
          base: (data["base"] as Record<string, unknown> | undefined)?.["ref"],
          draft: data["draft"]
        };
      }
    }
  ];
  return tools.map((tool) => ({
    ...tool,
    handler: async (input) => {
      try {
        return await tool.handler(input);
      } catch (error) {
        if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
          return { error: "GitHub request timed out." };
        }
        throw error;
      }
    }
  }));
}
