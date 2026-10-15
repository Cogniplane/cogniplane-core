// The only Atlassian URLs the Jira connection may request through the proxy.
// Each request kind maps to one fixed GET template on api.atlassian.com, the
// host the Pipedream Jira app uses. Hosts and paths never come from callers:
// the cloud ID is the stored, verified site and every interpolated value is
// validated here, so a prompt-injected argument cannot reach another endpoint.

export const JIRA_ACCESSIBLE_RESOURCES_URL = "https://api.atlassian.com/oauth/token/accessible-resources";

export const JIRA_MAX_PAGE_SIZE = 100;
export const JIRA_MAX_FIELDS = 30;

const CLOUD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Project keys start with a letter; numeric IDs are also accepted by Jira.
const ISSUE_ID_OR_KEY_PATTERN = /^(?:[A-Z][A-Z0-9_]{0,254}-[1-9][0-9]{0,17}|[1-9][0-9]{0,17})$/;
const FIELD_PATTERN = /^[A-Za-z0-9_.*-]{1,100}$/;
const MAX_JQL_LENGTH = 4_000;
const MAX_PAGE_TOKEN_LENGTH = 2_000;

export type JiraReadRequest =
  | { kind: "search"; jql: string; fields: string[]; maxResults: number; nextPageToken: string | null }
  | { kind: "issue"; issueIdOrKey: string; fields: string[] }
  | { kind: "changelog"; issueIdOrKey: string; startAt: number; maxResults: number };

export class JiraReadRequestError extends Error {
  constructor(readonly field: string, message: string) {
    super(message);
    this.name = "JiraReadRequestError";
  }
}

export function isJiraCloudId(value: unknown): value is string {
  return typeof value === "string" && CLOUD_ID_PATTERN.test(value);
}

export function isJiraIssueIdOrKey(value: unknown): value is string {
  return typeof value === "string" && ISSUE_ID_OR_KEY_PATTERN.test(value);
}

function checkPageSize(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > JIRA_MAX_PAGE_SIZE) {
    throw new JiraReadRequestError("maxResults", `maxResults must be an integer from 1 to ${JIRA_MAX_PAGE_SIZE}.`);
  }
}

function checkFields(fields: string[]): void {
  if (fields.length > JIRA_MAX_FIELDS || fields.some((field) => !FIELD_PATTERN.test(field))) {
    throw new JiraReadRequestError("fields", `fields must hold at most ${JIRA_MAX_FIELDS} Jira field IDs.`);
  }
}

function checkIssue(value: string): void {
  if (!isJiraIssueIdOrKey(value)) {
    throw new JiraReadRequestError("issueKey", "issueKey must be a Jira issue key (for example PROJ-123) or a numeric issue ID.");
  }
}

export function buildJiraReadUrl(cloudId: string, request: JiraReadRequest): string {
  if (!isJiraCloudId(cloudId)) throw new JiraReadRequestError("siteId", "The stored Jira site ID is not valid.");
  const base = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3`;
  const query = new URLSearchParams();

  switch (request.kind) {
    case "search": {
      if (request.jql.trim().length === 0 || request.jql.length > MAX_JQL_LENGTH) {
        throw new JiraReadRequestError("jql", `jql must be a bounded JQL query of 1 to ${MAX_JQL_LENGTH} characters.`);
      }
      checkPageSize(request.maxResults);
      checkFields(request.fields);
      query.set("jql", request.jql);
      query.set("maxResults", String(request.maxResults));
      if (request.fields.length > 0) query.set("fields", request.fields.join(","));
      if (request.nextPageToken !== null) {
        if (request.nextPageToken.length === 0 || request.nextPageToken.length > MAX_PAGE_TOKEN_LENGTH) {
          throw new JiraReadRequestError("nextPageToken", "nextPageToken is not valid.");
        }
        query.set("nextPageToken", request.nextPageToken);
      }
      return `${base}/search/jql?${query}`;
    }
    case "issue": {
      checkIssue(request.issueIdOrKey);
      checkFields(request.fields);
      if (request.fields.length > 0) query.set("fields", request.fields.join(","));
      const suffix = query.size > 0 ? `?${query}` : "";
      return `${base}/issue/${request.issueIdOrKey}${suffix}`;
    }
    case "changelog": {
      checkIssue(request.issueIdOrKey);
      checkPageSize(request.maxResults);
      if (!Number.isInteger(request.startAt) || request.startAt < 0 || request.startAt > 1_000_000) {
        throw new JiraReadRequestError("startAt", "startAt must be a non-negative integer.");
      }
      query.set("startAt", String(request.startAt));
      query.set("maxResults", String(request.maxResults));
      return `${base}/issue/${request.issueIdOrKey}/changelog?${query}`;
    }
  }
}
