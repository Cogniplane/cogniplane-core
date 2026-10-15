import { describe, expect, test } from "vitest";

import { buildJiraReadUrl, JiraReadRequestError, type JiraReadRequest } from "./jira-read-endpoints.js";
import { PIPEDREAM_MAX_RESPONSE_BYTES, PipedreamConnectClient, PipedreamRequestError } from "./pipedream-client.js";

const settings = {
  clientId: "client-id",
  clientSecret: "client-secret-value",
  projectId: "proj_abc123",
  environment: "development" as const
};
const CLOUD = "11111111-2222-4333-8444-555555555555";

function fakeFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    if (url.endsWith("/v1/oauth/token")) {
      return Response.json({ access_token: "pd-access-token", token_type: "Bearer", expires_in: 3600 });
    }
    return handler(url, init);
  };
  return { calls, fetchImpl };
}

describe("PipedreamConnectClient", () => {
  test("proxies a GET with a base64url target, the account, and the environment header", async () => {
    const { calls, fetchImpl } = fakeFetch(() => Response.json({ issues: [] }));
    const client = new PipedreamConnectClient(settings, fetchImpl);
    const target = `https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/search/jql?jql=project+%3D+ABC`;

    const result = await client.proxyGet({ externalUserId: "cp1_x", accountId: "apn_1", url: target });
    await client.proxyGet({ externalUserId: "cp1_x", accountId: "apn_1", url: target });

    expect(result).toEqual({ status: 200, body: { issues: [] } });
    // One client-credentials exchange serves both requests.
    expect(calls.filter((call) => call.url.endsWith("/oauth/token"))).toHaveLength(1);
    const proxy = new URL(calls[1].url);
    expect(proxy.origin + proxy.pathname.replace(/[^/]+$/, "")).toBe("https://api.pipedream.com/v1/connect/proj_abc123/proxy/");
    expect(Buffer.from(proxy.pathname.split("/").pop()!, "base64url").toString("utf8")).toBe(target);
    expect(Object.fromEntries(proxy.searchParams)).toEqual({ external_user_id: "cp1_x", account_id: "apn_1" });
    expect(calls[1].init.method).toBe("GET");
    expect(calls[1].init.headers).toMatchObject({
      Authorization: "Bearer pd-access-token",
      "x-pd-environment": "development"
    });
  });

  test("returns upstream error statuses to the caller instead of throwing", async () => {
    const { fetchImpl } = fakeFetch(() => Response.json({ errorMessages: ["nope"] }, { status: 403 }));
    const client = new PipedreamConnectClient(settings, fetchImpl);
    expect(await client.proxyGet({ externalUserId: "e", accountId: "apn_1", url: "https://api.atlassian.com/x" }))
      .toEqual({ status: 403, body: { errorMessages: ["nope"] } });
  });

  test("errors carry the status only, never the response body or secrets", async () => {
    const { fetchImpl } = fakeFetch(() => new Response(`{"leak":"${settings.clientSecret}"}`, { status: 500 }));
    const client = new PipedreamConnectClient(settings, fetchImpl);
    const error = await client.listAccounts({ externalUserId: "e", app: "jira" }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(PipedreamRequestError);
    expect(error).toMatchObject({ status: 500, operation: "list_accounts" });
    expect(String((error as Error).message)).not.toContain(settings.clientSecret);
    expect(JSON.stringify(error)).not.toContain(settings.clientSecret);
  });

  test("rejects a response over the size cap", async () => {
    const { fetchImpl } = fakeFetch(() => new Response("x".repeat(PIPEDREAM_MAX_RESPONSE_BYTES + 1)));
    const client = new PipedreamConnectClient(settings, fetchImpl);
    await expect(client.proxyGet({ externalUserId: "e", accountId: "apn_1", url: "https://api.atlassian.com/x" }))
      .rejects.toMatchObject({ reason: "too_large" });
  });

  test("maps a timeout to a typed error", async () => {
    const client = new PipedreamConnectClient(settings, async () => {
      throw new DOMException("timed out", "TimeoutError");
    });
    await expect(client.getAccount("apn_1")).rejects.toMatchObject({ reason: "timeout", status: 0 });
  });

  test("treats a missing account as null and an already deleted account as false", async () => {
    const { fetchImpl } = fakeFetch(() => new Response(null, { status: 404 }));
    const client = new PipedreamConnectClient(settings, fetchImpl);
    expect(await client.getAccount("apn_1")).toBeNull();
    expect(await client.deleteAccount("apn_1")).toBe(false);
  });

  test("does not request credentials when listing accounts", async () => {
    const { calls, fetchImpl } = fakeFetch(() => Response.json({ data: [], page_info: { count: 0, total_count: 0 } }));
    await new PipedreamConnectClient(settings, fetchImpl).listAccounts({ externalUserId: "e", app: "jira" });
    expect(new URL(calls[1].url).searchParams.get("include_credentials")).toBe("false");
  });

  test("follows end_cursor until total_count is reached", async () => {
    const account = (id: string) => ({ id, external_id: "e", app: { name_slug: "jira" } });
    const { calls, fetchImpl } = fakeFetch((url) => new URL(url).searchParams.get("after") === "cur_1"
      ? Response.json({ data: [account("apn_2")], page_info: { count: 1, total_count: 2, end_cursor: null } })
      : Response.json({ data: [account("apn_1")], page_info: { count: 1, total_count: 2, end_cursor: "cur_1" } }));
    const accounts = await new PipedreamConnectClient(settings, fetchImpl).listAccounts({ externalUserId: "e", app: "jira" });
    expect(accounts.map((entry) => entry.id)).toEqual(["apn_1", "apn_2"]);
    expect(calls.slice(1).map((call) => new URL(call.url).searchParams.get("after"))).toEqual([null, "cur_1"]);
  });

  test("rejects a listing without page_info", async () => {
    const { fetchImpl } = fakeFetch(() => Response.json({ data: [] }));
    await expect(new PipedreamConnectClient(settings, fetchImpl).listAccounts({ externalUserId: "e", app: "jira" }))
      .rejects.toMatchObject({ reason: "invalid_response" });
  });
});

describe("Jira read allowlist", () => {
  test("builds the fixed v3 endpoints", () => {
    expect(buildJiraReadUrl(CLOUD, { kind: "search", jql: "project = ABC", fields: ["summary"], maxResults: 50, nextPageToken: "tok" }))
      .toBe(`https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/search/jql?jql=project+%3D+ABC&maxResults=50&fields=summary&nextPageToken=tok`);
    expect(buildJiraReadUrl(CLOUD, { kind: "issue", issueIdOrKey: "ABC-12", fields: [] }))
      .toBe(`https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/issue/ABC-12`);
    expect(buildJiraReadUrl(CLOUD, { kind: "changelog", issueIdOrKey: "10001", startAt: 100, maxResults: 100 }))
      .toBe(`https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/issue/10001/changelog?startAt=100&maxResults=100`);
  });

  test.each<[string, JiraReadRequest]>([
    ["path traversal in the issue key", { kind: "issue", issueIdOrKey: "../../myself", fields: [] }],
    ["a query in the issue key", { kind: "issue", issueIdOrKey: "ABC-1?expand=x", fields: [] }],
    ["a host in the issue key", { kind: "changelog", issueIdOrKey: "https://evil.test", startAt: 0, maxResults: 10 }],
    ["an oversized page", { kind: "search", jql: "project = A", fields: [], maxResults: 101, nextPageToken: null }],
    ["an empty JQL query", { kind: "search", jql: "  ", fields: [], maxResults: 10, nextPageToken: null }],
    ["a field with a separator", { kind: "issue", issueIdOrKey: "ABC-1", fields: ["summary&expand=changelog"] }],
    ["a negative offset", { kind: "changelog", issueIdOrKey: "ABC-1", startAt: -1, maxResults: 10 }]
  ])("rejects %s", (_label, request) => {
    expect(() => buildJiraReadUrl(CLOUD, request)).toThrow(JiraReadRequestError);
  });

  test("rejects a cloud ID that is not a UUID", () => {
    expect(() => buildJiraReadUrl("evil.test/x", { kind: "issue", issueIdOrKey: "ABC-1", fields: [] }))
      .toThrow(JiraReadRequestError);
  });
});
