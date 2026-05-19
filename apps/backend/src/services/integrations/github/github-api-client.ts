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
    })
  });

  const payload = await parseGithubJson<GithubTokenResponse>(response);
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description ?? payload.error ?? "github_token_exchange_failed");
  }

  return { ...payload, access_token: payload.access_token };
}

export async function refreshUserAccessToken(
  config: AppConfig,
  refreshToken: string
): Promise<GithubTokenResponse | null> {
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
    })
  });

  const payload = await parseGithubJson<GithubTokenResponse>(response);
  if (!response.ok || !payload.access_token) {
    return null;
  }
  return payload;
}

export async function selectGithubEmail(token: string): Promise<string | null> {
  const response = await fetch(`${GITHUB_API_URL}/user/emails`, {
    headers: buildGithubApiHeaders(token)
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
    headers: buildGithubApiHeaders(accessToken)
  });
  if (!userResponse.ok) {
    throw new Error("github_user_fetch_failed");
  }
  return parseGithubJson<GithubUserResponse>(userResponse);
}
