import type { AppConfig } from "../../../config.js";

export const GITHUB_OAUTH_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
export const GITHUB_OAUTH_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const GITHUB_API_URL = "https://api.github.com";
export const GITHUB_API_VERSION = "2022-11-28";

export type GithubTokenResponse = {
  access_token?: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
};

export type GithubUserResponse = {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
};

export type GithubEmailResponse = Array<{
  email: string;
  verified: boolean;
  primary: boolean;
}>;

export function buildGithubApiHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "cogniplane-core",
    "X-GitHub-Api-Version": GITHUB_API_VERSION
  };
}

export async function parseGithubJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

// Bounds every GitHub OAuth and profile request. Without it a stalled
// connection holds the OAuth callback or the tool call that refreshes a token.
export const GITHUB_REQUEST_TIMEOUT_MS = 15_000;

// A gateway error can have a non-JSON body. Read an error body only for its message.
async function readGithubTokenError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as GithubTokenResponse;
    return payload.error_description ?? payload.error ?? "github_token_exchange_failed";
  } catch {
    return "github_token_exchange_failed";
  }
}

export async function exchangeUserAuthorizationCode(
  config: AppConfig,
  code: string
): Promise<GithubTokenResponse & { access_token: string }> {
  const response = await fetch(GITHUB_OAUTH_ACCESS_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "cogniplane-core"
    },
    body: JSON.stringify({
      client_id: config.GITHUB_OAUTH_CLIENT_ID,
      client_secret: config.GITHUB_OAUTH_CLIENT_SECRET,
      code,
      redirect_uri: config.GITHUB_OAUTH_REDIRECT_URI
    }),
    signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS)
  });

  if (!response.ok) throw new Error(await readGithubTokenError(response));
  const payload = await parseGithubJson<GithubTokenResponse>(response);
  if (!payload.access_token) {
    throw new Error(payload.error_description ?? payload.error ?? "github_token_exchange_failed");
  }

  return { ...payload, access_token: payload.access_token };
}

export async function refreshUserAccessToken(
  config: AppConfig,
  refreshToken: string
): Promise<GithubTokenResponse | null> {
  // A failed refresh returns null, so the caller keeps the access token it has.
  // That token can still be valid inside the refresh window.
  try {
    const response = await fetch(GITHUB_OAUTH_ACCESS_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "cogniplane-core"
      },
      body: JSON.stringify({
        client_id: config.GITHUB_OAUTH_CLIENT_ID,
        client_secret: config.GITHUB_OAUTH_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: refreshToken
      }),
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS)
    });
    if (!response.ok) return null;
    const payload = await parseGithubJson<GithubTokenResponse>(response);
    return payload.access_token ? payload : null;
  } catch {
    return null;
  }
}

export async function selectGithubEmail(token: string): Promise<string | null> {
  const response = await fetch(`${GITHUB_API_URL}/user/emails`, {
    headers: buildGithubApiHeaders(token),
    signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS)
  });

  if (!response.ok) {
    return null;
  }

  const emails = await parseGithubJson<GithubEmailResponse>(response);
  const preferred =
    emails.find((entry) => entry.primary && entry.verified) ??
    emails.find((entry) => entry.verified) ??
    emails[0];

  return preferred?.email ?? null;
}

export async function fetchUserProfile(accessToken: string): Promise<GithubUserResponse> {
  const userResponse = await fetch(`${GITHUB_API_URL}/user`, {
    headers: buildGithubApiHeaders(accessToken),
    signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS)
  });
  if (!userResponse.ok) {
    throw new Error("github_user_fetch_failed");
  }
  return parseGithubJson<GithubUserResponse>(userResponse);
}

/** A GitHub API response that is not a success. `status` is the HTTP status. */
export class GithubApiError extends Error {
  constructor(readonly status: number) {
    super(`github_api_error_${status}`);
    this.name = "GithubApiError";
  }
}

export type GithubRepositorySummary = { fullName: string; private: boolean; archived: boolean };

type GithubRepositoryResponse = Array<{ full_name?: unknown; private?: unknown; archived?: unknown }>;

const REPOSITORY_LIST_PAGE_SIZE = 100;
// One listing returns at most this many repositories. A member whose account
// has more adds the rest by name.
const REPOSITORY_LIST_MAX_PAGES = 3;

/**
 * List the repositories that the token can reach, for the member to choose
 * from. This is a settings call, never a tool call: the model cannot reach it.
 */
export async function listUserRepositories(
  token: string
): Promise<{ repositories: GithubRepositorySummary[]; truncated: boolean }> {
  const repositories: GithubRepositorySummary[] = [];
  let truncated = false;
  for (let page = 1; page <= REPOSITORY_LIST_MAX_PAGES; page += 1) {
    const response = await fetch(
      `${GITHUB_API_URL}/user/repos?per_page=${REPOSITORY_LIST_PAGE_SIZE}&page=${page}` +
        "&sort=pushed&affiliation=owner,collaborator,organization_member",
      { headers: buildGithubApiHeaders(token), signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS) }
    );
    if (!response.ok) throw new GithubApiError(response.status);
    const entries = await parseGithubJson<GithubRepositoryResponse>(response);
    for (const entry of entries) {
      if (typeof entry.full_name !== "string") continue;
      repositories.push({
        fullName: entry.full_name,
        private: entry.private === true,
        archived: entry.archived === true
      });
    }
    if (entries.length < REPOSITORY_LIST_PAGE_SIZE) return { repositories, truncated };
    truncated = page === REPOSITORY_LIST_MAX_PAGES;
  }
  return { repositories, truncated };
}
