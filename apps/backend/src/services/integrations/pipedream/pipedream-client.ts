import { z } from "zod";

import type { AppConfig } from "../../../config.js";
import { readBodyWithLimit } from "../../../lib/mcp-upstream-client.js";

// Minimal Pipedream Connect REST client. Request and response shapes follow
// the Connect API reference and the official TypeScript SDK
// (PipedreamHQ/pipedream-sdk-typescript): OAuth client credentials, Connect
// tokens, accounts, and the GET proxy. No live call has checked them yet.
// Server-only: the client secret and the access token never leave this
// module, and errors never carry response bodies.

const PIPEDREAM_API_BASE = "https://api.pipedream.com/v1";
const REQUEST_TIMEOUT_MS = 15_000;
// Jira issue pages with many fields are hundreds of KB. 2 MiB bounds memory
// per call without cutting normal pages.
export const PIPEDREAM_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const TOKEN_REFRESH_MARGIN_MS = 60_000;

export type PipedreamSettings = {
  clientId: string;
  clientSecret: string;
  projectId: string;
  environment: "development" | "production";
};

export function readPipedreamSettings(
  config: Pick<
    AppConfig,
    "PIPEDREAM_CLIENT_ID" | "PIPEDREAM_CLIENT_SECRET" | "PIPEDREAM_PROJECT_ID" | "PIPEDREAM_PROJECT_ENVIRONMENT"
  >
): PipedreamSettings | null {
  if (!config.PIPEDREAM_CLIENT_ID || !config.PIPEDREAM_CLIENT_SECRET || !config.PIPEDREAM_PROJECT_ID) return null;
  return {
    clientId: config.PIPEDREAM_CLIENT_ID,
    clientSecret: config.PIPEDREAM_CLIENT_SECRET,
    projectId: config.PIPEDREAM_PROJECT_ID,
    environment: config.PIPEDREAM_PROJECT_ENVIRONMENT
  };
}

/** Status-only failure. `status` is 0 for timeouts, network errors, invalid bodies, and incomplete listings. */
export class PipedreamRequestError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    readonly reason: "http" | "timeout" | "network" | "too_large" | "invalid_response" | "incomplete_listing" = "http"
  ) {
    super(`Pipedream ${operation} failed (${reason}${status ? ` ${status}` : ""}).`);
    this.name = "PipedreamRequestError";
  }
}

const OAuthTokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive()
});

const ConnectTokenSchema = z.object({
  token: z.string().min(1),
  expires_at: z.string(),
  connect_link_url: z.string().url()
});

export const PipedreamAccountSchema = z.object({
  id: z.string().regex(/^apn_[A-Za-z0-9]+$/),
  name: z.string().nullish(),
  external_id: z.string().nullish(),
  healthy: z.boolean().nullish(),
  dead: z.boolean().nullish(),
  app: z.object({ name_slug: z.string() }).passthrough().nullish(),
  created_at: z.string().nullish()
}).passthrough();
export type PipedreamAccount = z.infer<typeof PipedreamAccountSchema>;

const AccountListSchema = z.object({
  data: z.array(PipedreamAccountSchema),
  page_info: z.object({
    total_count: z.number().int().nonnegative(),
    end_cursor: z.string().nullish()
  }).passthrough()
}).passthrough();

// Upper bound on list requests for one external user and app. With pages of
// ACCOUNT_PAGE_SIZE, this covers 500 accounts.
const ACCOUNT_PAGE_SIZE = 20;
export const MAX_ACCOUNT_PAGES = 25;

export type ProxyResult = { status: number; body: unknown };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class PipedreamConnectClient {
  private accessToken: { value: string; expiresAt: number } | null = null;
  private pendingToken: Promise<string> | null = null;

  constructor(
    private readonly settings: PipedreamSettings,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  async createConnectToken(input: {
    externalUserId: string;
    successRedirectUri: string;
    errorRedirectUri: string;
    expiresInSeconds: number;
  }): Promise<{ connectLinkUrl: string; expiresAt: string }> {
    const body = await this.requestJson("create_connect_token", "POST", this.projectPath("/tokens"), {
      external_user_id: input.externalUserId,
      success_redirect_uri: input.successRedirectUri,
      error_redirect_uri: input.errorRedirectUri,
      expires_in: input.expiresInSeconds
    });
    const parsed = ConnectTokenSchema.safeParse(body);
    if (!parsed.success) throw new PipedreamRequestError("create_connect_token", 0, "invalid_response");
    return { connectLinkUrl: parsed.data.connect_link_url, expiresAt: parsed.data.expires_at };
  }

  /**
   * Every account of one external user and app, following `page_info`
   * cursors. Throws `incomplete_listing` when a page has no new cursor before
   * `total_count` is reached, when a cursor repeats, or after
   * MAX_ACCOUNT_PAGES requests. Never includes credentials.
   */
  async listAccounts(input: { externalUserId: string; app: string }): Promise<PipedreamAccount[]> {
    const accounts = new Map<string, PipedreamAccount>();
    const cursors = new Set<string>();
    let after: string | null = null;
    for (let page = 0; page < MAX_ACCOUNT_PAGES; page += 1) {
      const query = new URLSearchParams({
        external_user_id: input.externalUserId,
        app: input.app,
        limit: String(ACCOUNT_PAGE_SIZE),
        include_credentials: "false"
      });
      if (after) query.set("after", after);
      const body = await this.requestJson("list_accounts", "GET", this.projectPath(`/accounts?${query}`));
      const parsed = AccountListSchema.safeParse(body);
      if (!parsed.success) throw new PipedreamRequestError("list_accounts", 0, "invalid_response");
      for (const account of parsed.data.data) accounts.set(account.id, account);
      if (accounts.size >= parsed.data.page_info.total_count) return [...accounts.values()];
      const next = parsed.data.page_info.end_cursor;
      if (!next || cursors.has(next) || parsed.data.data.length === 0) break;
      cursors.add(next);
      after = next;
    }
    throw new PipedreamRequestError("list_accounts", 0, "incomplete_listing");
  }

  async getAccount(accountId: string): Promise<PipedreamAccount | null> {
    const path = this.projectPath(`/accounts/${encodeURIComponent(accountId)}?include_credentials=false`);
    try {
      const parsed = PipedreamAccountSchema.safeParse(await this.requestJson("get_account", "GET", path));
      if (!parsed.success) throw new PipedreamRequestError("get_account", 0, "invalid_response");
      return parsed.data;
    } catch (error) {
      if (error instanceof PipedreamRequestError && error.status === 404) return null;
      throw error;
    }
  }

  /** Returns false when the account was already gone. Throws on every other failure. */
  async deleteAccount(accountId: string): Promise<boolean> {
    try {
      await this.requestJson("delete_account", "DELETE", this.projectPath(`/accounts/${encodeURIComponent(accountId)}`));
      return true;
    } catch (error) {
      if (error instanceof PipedreamRequestError && error.status === 404) return false;
      throw error;
    }
  }

  /**
   * GET through the Connect proxy. Callers pass only URLs from the Jira read
   * allowlist. Non-2xx upstream statuses come back as `status`; the body is
   * returned only for the caller to pick known, credential-free fields.
   */
  async proxyGet(input: { externalUserId: string; accountId: string; url: string }): Promise<ProxyResult> {
    const url64 = Buffer.from(input.url, "utf8").toString("base64url");
    const query = new URLSearchParams({ external_user_id: input.externalUserId, account_id: input.accountId });
    const response = await this.send("proxy", "GET", this.projectPath(`/proxy/${url64}?${query}`), undefined, {
      "x-pd-proxy-accept": "application/json"
    });
    return { status: response.status, body: await this.readJson("proxy", response) };
  }

  private projectPath(path: string): string {
    return `${PIPEDREAM_API_BASE}/connect/${encodeURIComponent(this.settings.projectId)}${path}`;
  }

  private async requestJson(operation: string, method: string, url: string, body?: unknown): Promise<unknown> {
    const response = await this.send(operation, method, url, body);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new PipedreamRequestError(operation, response.status);
    }
    return this.readJson(operation, response);
  }

  private async send(
    operation: string,
    method: string,
    url: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {}
  ): Promise<Response> {
    const token = await this.getAccessToken();
    return this.fetchWithTimeout(operation, url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "x-pd-environment": this.settings.environment,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...extraHeaders
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) {
      return this.accessToken.value;
    }
    this.pendingToken ??= this.fetchAccessToken().finally(() => {
      this.pendingToken = null;
    });
    return this.pendingToken;
  }

  private async fetchAccessToken(): Promise<string> {
    const response = await this.fetchWithTimeout("oauth_token", `${PIPEDREAM_API_BASE}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: this.settings.clientId,
        client_secret: this.settings.clientSecret
      })
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new PipedreamRequestError("oauth_token", response.status);
    }
    const parsed = OAuthTokenSchema.safeParse(await this.readJson("oauth_token", response));
    if (!parsed.success) throw new PipedreamRequestError("oauth_token", 0, "invalid_response");
    this.accessToken = {
      value: parsed.data.access_token,
      expiresAt: Date.now() + parsed.data.expires_in * 1000
    };
    return parsed.data.access_token;
  }

  private async fetchWithTimeout(operation: string, url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new PipedreamRequestError(operation, 0, timedOut ? "timeout" : "network");
    }
  }

  private async readJson(operation: string, response: Response): Promise<unknown> {
    let text: string | null;
    try {
      text = await readBodyWithLimit(response.body, PIPEDREAM_MAX_RESPONSE_BYTES);
    } catch {
      throw new PipedreamRequestError(operation, 0, "network");
    }
    if (text === null) throw new PipedreamRequestError(operation, 0, "too_large");
    if (text === "") return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      if (!response.ok) return null;
      throw new PipedreamRequestError(operation, 0, "invalid_response");
    }
  }
}
