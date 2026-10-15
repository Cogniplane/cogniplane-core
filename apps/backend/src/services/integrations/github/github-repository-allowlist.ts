import { GITHUB_ALLOWED_REPOSITORY_LIMIT, parseGithubRepositoryName } from "@cogniplane/shared-types";

export type GithubRepositoryRef = { owner: string; name: string };

/** The list that a member edits is not valid: a name is malformed, or there are too many. */
export class InvalidGithubRepositoryListError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = "InvalidGithubRepositoryListError";
  }
}

/** The form that the allowlist stores and compares: `owner/name` in lower case. */
export function repositoryKey(repo: GithubRepositoryRef): string {
  return `${repo.owner}/${repo.name}`.toLowerCase();
}

/**
 * Validate and normalize a list of repositories that a member chose.
 * GitHub treats repository names as case-insensitive, so the list is stored in
 * lower case, without duplicates, in a stable order.
 */
export function normalizeAllowedRepositories(values: readonly string[]): string[] {
  const keys = new Set<string>();
  for (const value of values) {
    const parsed = parseGithubRepositoryName(value.trim());
    if (!parsed) {
      throw new InvalidGithubRepositoryListError("Each repository must use the form owner/name.");
    }
    keys.add(repositoryKey(parsed));
  }
  if (keys.size > GITHUB_ALLOWED_REPOSITORY_LIMIT) {
    throw new InvalidGithubRepositoryListError(
      `Choose at most ${GITHUB_ALLOWED_REPOSITORY_LIMIT} repositories.`
    );
  }
  return [...keys].sort();
}

export function isRepositoryAllowed(allowed: readonly string[], repo: GithubRepositoryRef): boolean {
  const key = repositoryKey(repo);
  return allowed.some((entry) => entry.toLowerCase() === key);
}
