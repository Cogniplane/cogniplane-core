import { z } from "zod";

import type { JiraConnectionService, JiraSiteView } from "../integrations/pipedream/jira-connection-service.js";
import { JIRA_MAX_FIELDS, JIRA_MAX_PAGE_SIZE } from "../integrations/pipedream/jira-read-endpoints.js";
import {
  allRequiredObjectSchema,
  arraySchema,
  genericObjectSchema,
  nullableNumberSchema,
  nullableStringSchema,
  withManagedToolErrorSchema,
  type ManagedToolDefinition
} from "./types.js";
import { boundIntegrationAccount } from "../integrations/integration-account-binding.js";

// Read-only Jira tools. They know nothing about the vendor: every call goes
// through `JiraConnectionService.read`, which checks tenant enablement and the
// member's stored connection, and sends only allowlisted GET requests. Each
// call returns one page plus continuation fields; nothing is merged or cut.
// Responses are checked against the minimal shape the tools use. A body that
// does not match, or a page that says "more" without a way to continue, is a
// tool error, never an empty or complete page.

// Fields a recap needs. Callers can ask for others, up to JIRA_MAX_FIELDS.
const DEFAULT_SEARCH_FIELDS = [
  "summary", "status", "issuetype", "priority", "assignee", "reporter", "project",
  "parent", "labels", "created", "updated", "resolution", "resolutiondate"
];
const DEFAULT_ISSUE_FIELDS = [...DEFAULT_SEARCH_FIELDS, "description", "components", "fixVersions", "duedate"];
// Link and avatar metadata repeats on every user, status, and project object.
const NOISE_KEYS = new Set(["self", "avatarUrls", "iconUrl", "expand"]);

const MALFORMED_ERROR = "Jira returned a response in an unexpected format. Try again later.";
const PAGING_ERROR = "Jira returned a partial page with no way to continue. Try again later.";

const IssueBodySchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  fields: z.record(z.string(), z.unknown()).optional()
}).passthrough();

const SearchBodySchema = z.object({
  issues: z.array(IssueBodySchema),
  isLast: z.boolean().optional(),
  nextPageToken: z.string().min(1).optional()
}).passthrough();

const ChangelogBodySchema = z.object({
  values: z.array(z.object({
    id: z.string(),
    created: z.string().optional(),
    author: z.object({ accountId: z.string().optional(), displayName: z.string().optional() }).passthrough().nullish(),
    items: z.array(z.unknown()).optional()
  }).passthrough()),
  startAt: z.number().int().nonnegative().optional(),
  maxResults: z.number().int().nonnegative().optional(),
  total: z.number().int().nonnegative().optional(),
  isLast: z.boolean().optional()
}).passthrough();

type JiraToolDeps = { jiraConnections: Pick<JiraConnectionService, "read"> };

const fieldsSchema = {
  type: "array",
  items: { type: "string" },
  maxItems: JIRA_MAX_FIELDS,
  description: "Jira field IDs to return. Omit for a recap-oriented default set."
};
const siteSchema = allRequiredObjectSchema({ siteId: { type: "string" }, name: { type: "string" }, url: { type: "string" } });

export const JIRA_TOOL_CATALOG: ReadonlyArray<{
  name: string;
  description: string;
  readOnly: boolean;
  inputSchema: Record<string, unknown>;
}> = [
  {
    name: "jira_list_sites",
    description: "List the Jira Cloud sites the connected Jira account can access, and the site the user selected. Tools read only the selected site.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: { toolContextId: { type: "string" } },
      required: ["toolContextId"],
      additionalProperties: false
    }
  },
  {
    name: "jira_search_issues",
    description:
      "Search issues in the selected Jira site with a bounded JQL query (for example `project = ABC AND updated >= -7d`). Returns one page. When isLast is false, call again with nextPageToken. `updated` only shows that something changed; to tell if work was completed, check status, resolution, resolutiondate, or the issue changelog.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        toolContextId: { type: "string" },
        jql: { type: "string", description: "Bounded JQL. Unbounded queries such as `order by created` are rejected by Jira." },
        fields: fieldsSchema,
        maxResults: { type: "number", description: `1 to ${JIRA_MAX_PAGE_SIZE}, default 50.` },
        nextPageToken: { type: "string", description: "Token from the previous page." }
      },
      required: ["toolContextId", "jql"],
      additionalProperties: false
    }
  },
  {
    name: "jira_get_issue",
    description: "Read one issue in the selected Jira site by key (for example ABC-123) or numeric ID.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        toolContextId: { type: "string" },
        issueKey: { type: "string" },
        fields: fieldsSchema
      },
      required: ["toolContextId", "issueKey"],
      additionalProperties: false
    }
  },
  {
    name: "jira_get_issue_changelog",
    description:
      "Read one page of an issue's change history, oldest first: status transitions, assignee changes, and other field edits with author and time. When isLast is false, call again with startAt set to nextStartAt.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        toolContextId: { type: "string" },
        issueKey: { type: "string" },
        startAt: { type: "number", description: "Zero-based offset, default 0." },
        maxResults: { type: "number", description: `1 to ${JIRA_MAX_PAGE_SIZE}, default 100.` }
      },
      required: ["toolContextId", "issueKey"],
      additionalProperties: false
    }
  }
];

export const JIRA_READ_TOOL_IDS = JIRA_TOOL_CATALOG.map((entry) => entry.name);

function compact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compact);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!NOISE_KEYS.has(key)) out[key] = compact(entry);
  }
  return out;
}

function readFields(value: unknown, fallback: string[]): string[] | { error: string } {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.some((field) => typeof field !== "string")) {
    return { error: "fields must be an array of Jira field IDs." };
  }
  return value as string[];
}

function readInteger(value: unknown, fallback: number): number {
  return value === undefined ? fallback : typeof value === "number" ? value : Number.NaN;
}

function summarizeIssue(issue: z.infer<typeof IssueBodySchema>, site: JiraSiteView) {
  return {
    id: issue.id,
    key: issue.key,
    url: `${site.url.replace(/\/+$/, "")}/browse/${encodeURIComponent(issue.key)}`,
    fields: compact(issue.fields ?? {})
  };
}

const issueSchema = allRequiredObjectSchema({
  id: { type: "string" },
  key: { type: "string" },
  url: { type: "string" },
  fields: genericObjectSchema
});

export function createJiraTools(deps: JiraToolDeps): ManagedToolDefinition[] {
  const [listSites, searchIssues, getIssue, getChangelog] = JIRA_TOOL_CATALOG;
  return [
    {
      ...listSites,
      outputSchema: withManagedToolErrorSchema(allRequiredObjectSchema({
        selectedSiteId: { type: "string" },
        sites: arraySchema(siteSchema)
      })),
      handler: async ({ context }) => {
        const result = await deps.jiraConnections.read(context.tenantId, context.userId, { kind: "sites" },
          boundIntegrationAccount(context.metadata, "jira"));
        if (!result.ok) return { error: result.error };
        return { selectedSiteId: result.site.siteId, sites: result.data as JiraSiteView[] };
      }
    },
    {
      ...searchIssues,
      outputSchema: withManagedToolErrorSchema(allRequiredObjectSchema({
        site: siteSchema,
        issues: arraySchema(issueSchema),
        isLast: { type: "boolean" },
        nextPageToken: nullableStringSchema
      })),
      handler: async ({ context, arguments: args }) => {
        const fields = readFields(args.fields, DEFAULT_SEARCH_FIELDS);
        if (!Array.isArray(fields)) return fields;
        if (typeof args.jql !== "string") return { error: "jql must be a string." };
        if (args.nextPageToken !== undefined && typeof args.nextPageToken !== "string") {
          return { error: "nextPageToken must be a string." };
        }
        const result = await deps.jiraConnections.read(context.tenantId, context.userId, {
          kind: "search",
          jql: args.jql,
          fields,
          maxResults: readInteger(args.maxResults, 50),
          nextPageToken: args.nextPageToken ?? null
        }, boundIntegrationAccount(context.metadata, "jira"));
        if (!result.ok) return { error: result.error };
        const parsed = SearchBodySchema.safeParse(result.data);
        if (!parsed.success) return { error: MALFORMED_ERROR };
        const { issues, nextPageToken } = parsed.data;
        // Jira omits nextPageToken on the last page.
        const isLast = parsed.data.isLast ?? nextPageToken === undefined;
        if (!isLast && nextPageToken === undefined) return { error: PAGING_ERROR };
        return {
          site: result.site,
          issues: issues.map((issue) => summarizeIssue(issue, result.site)),
          isLast,
          nextPageToken: isLast ? null : nextPageToken ?? null
        };
      }
    },
    {
      ...getIssue,
      outputSchema: withManagedToolErrorSchema(allRequiredObjectSchema({ site: siteSchema, issue: issueSchema })),
      handler: async ({ context, arguments: args }) => {
        const fields = readFields(args.fields, DEFAULT_ISSUE_FIELDS);
        if (!Array.isArray(fields)) return fields;
        const result = await deps.jiraConnections.read(context.tenantId, context.userId, {
          kind: "issue",
          issueIdOrKey: String(args.issueKey ?? ""),
          fields
        }, boundIntegrationAccount(context.metadata, "jira"));
        if (!result.ok) return { error: result.error };
        const parsed = IssueBodySchema.safeParse(result.data);
        if (!parsed.success) return { error: MALFORMED_ERROR };
        return { site: result.site, issue: summarizeIssue(parsed.data, result.site) };
      }
    },
    {
      ...getChangelog,
      outputSchema: withManagedToolErrorSchema(allRequiredObjectSchema({
        site: siteSchema,
        issueKey: { type: "string" },
        startAt: { type: "number" },
        maxResults: { type: "number" },
        total: nullableNumberSchema,
        isLast: { type: "boolean" },
        nextStartAt: nullableNumberSchema,
        histories: arraySchema(genericObjectSchema)
      })),
      handler: async ({ context, arguments: args }) => {
        const issueKey = String(args.issueKey ?? "");
        const result = await deps.jiraConnections.read(context.tenantId, context.userId, {
          kind: "changelog",
          issueIdOrKey: issueKey,
          startAt: readInteger(args.startAt, 0),
          maxResults: readInteger(args.maxResults, JIRA_MAX_PAGE_SIZE)
        }, boundIntegrationAccount(context.metadata, "jira"));
        if (!result.ok) return { error: result.error };
        const parsed = ChangelogBodySchema.safeParse(result.data);
        if (!parsed.success) return { error: MALFORMED_ERROR };
        const data = parsed.data;
        const histories = data.values;
        const startAt = data.startAt ?? readInteger(args.startAt, 0);
        // Trust isLast when Jira sends it; otherwise derive it from total.
        const isLast = data.isLast ?? (data.total === undefined ? null : startAt + histories.length >= data.total);
        if (isLast === null) return { error: MALFORMED_ERROR };
        // An empty page that claims more would make the caller loop on one offset.
        if (!isLast && histories.length === 0) return { error: PAGING_ERROR };
        return {
          site: result.site,
          issueKey,
          startAt,
          maxResults: data.maxResults ?? histories.length,
          total: data.total ?? null,
          isLast,
          nextStartAt: isLast ? null : startAt + histories.length,
          histories: histories.map((history) => ({
            id: history.id,
            created: history.created ?? null,
            author: history.author
              ? { accountId: history.author.accountId ?? null, displayName: history.author.displayName ?? null }
              : null,
            items: compact(history.items ?? [])
          }))
        };
      }
    }
  ];
}
