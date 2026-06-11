import type { GithubConnectionService } from "../integrations/github/github-connection-service.js";
import {
  allRequiredObjectSchema,
  genericObjectSchema,
  safeJsonBody,
  strictObjectSchema,
  withManagedToolErrorSchema,
  type ManagedToolDefinition
} from "./types.js";

type GithubToolDeps = {
  githubConnections: GithubConnectionService;
};

// `repo` and `path` are interpolated into the GitHub API URL. The values come
// from LLM-supplied tool arguments, which can be influenced by prompt
// injection in any document or prior message — so they must be validated
// before becoming part of the URL or the agent could pivot to other GitHub
// API endpoints under the user's PAT (e.g. `/user`, other repos).
const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function parseRepo(repo: string): { owner: string; name: string } | null {
  if (!REPO_PATTERN.test(repo)) return null;
  const [owner, name] = repo.split("/", 2) as [string, string];
  // The character class permits a segment that is entirely dots, so `repo`
  // like "../name" or "owner/.." passes the regex. The WHATWG URL parser then
  // resolves the `..` and the request lands on a different api.github.com
  // endpoint under the user's PAT. Reject `.`/`..` segments outright (mirrors
  // encodeRepoPath's per-segment guard).
  if (owner === "." || owner === ".." || name === "." || name === "..") return null;
  return { owner, name };
}

function encodeRepoPath(input: string): string | null {
  const trimmed = input.replace(/^\/+/, "");
  if (trimmed.length === 0) return null;
  const segments = trimmed.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return null;
  }
  return segments.map(encodeURIComponent).join("/");
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
    description: "Read the contents of a file from a GitHub repository using the connected GitHub account.",
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
    description: "Create or update a file in a GitHub repository branch using the connected GitHub account.",
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
    description: "Open a pull request in a GitHub repository using the connected GitHub account.",
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: {
        toolContextId: { type: "string" },
        repo: { type: "string", description: "Full repo name, e.g. org/repo" },
        title: { type: "string" },
        body: { type: "string" },
        head: { type: "string", description: "Source branch (the branch with changes)" },
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
  return [
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
        const creds = await deps.githubConnections.getRuntimeCredentials(context.tenantId, context.userId);
        if (!creds) return { error: "No GitHub connection found. Connect your GitHub account in settings." };

        const parsedRepo = parseRepo(String(args.repo));
        if (!parsedRepo) return { error: "Invalid repo. Must match the pattern owner/name." };
        const encodedPath = encodeRepoPath(String(args.path));
        if (!encodedPath) return { error: "Invalid path. Must not contain '..' segments." };
        const ref = args.ref ? `?ref=${encodeURIComponent(String(args.ref))}` : "";

        const res = await fetch(
          `https://api.github.com/repos/${parsedRepo.owner}/${parsedRepo.name}/contents/${encodedPath}${ref}`,
          { headers: { Authorization: `Bearer ${creds.token}`, Accept: "application/vnd.github+json" } }
        );

        if (!res.ok) return { error: `GitHub API error ${res.status}`, detail: await safeJsonBody(res) };

        const data = (await res.json()) as Record<string, unknown>;
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
        const creds = await deps.githubConnections.getRuntimeCredentials(context.tenantId, context.userId);
        if (!creds) return { error: "No GitHub connection found. Connect your GitHub account in settings." };

        const parsedRepo = parseRepo(String(args.repo));
        if (!parsedRepo) return { error: "Invalid repo. Must match the pattern owner/name." };
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

        const res = await fetch(
          `https://api.github.com/repos/${parsedRepo.owner}/${parsedRepo.name}/contents/${encodedPath}`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${creds.token}`,
              Accept: "application/vnd.github+json",
              "Content-Type": "application/json"
            },
            body: JSON.stringify(body)
          }
        );

        const data = (await safeJsonBody(res)) as Record<string, Record<string, unknown>>;
        if (!res.ok) return { error: `GitHub API error ${res.status}`, detail: data };

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
        const creds = await deps.githubConnections.getRuntimeCredentials(context.tenantId, context.userId);
        if (!creds) return { error: "No GitHub connection found. Connect your GitHub account in settings." };

        const parsedRepo = parseRepo(String(args.repo));
        if (!parsedRepo) return { error: "Invalid repo. Must match the pattern owner/name." };
        const body = {
          title: String(args.title),
          body: args.body ? String(args.body) : "",
          head: String(args.head),
          base: String(args.base),
          draft: args.draft === true
        };

        const res = await fetch(`https://api.github.com/repos/${parsedRepo.owner}/${parsedRepo.name}/pulls`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${creds.token}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json"
          },
          body: JSON.stringify(body)
        });

        const data = await safeJsonBody(res);
        if (!res.ok) return { error: `GitHub API error ${res.status}`, detail: data };

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
}
