import type { AdminMcpServer } from "@cogniplane/shared-types";
import type { McpAudience } from "../../../lib/admin-api";

export function deriveMcpServerId(name: string, existingIds: readonly string[]): string {
  const base = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 72).replace(/-$/g, "") || "connection";
  const used = new Set(existingIds);
  if (!used.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

export function getMcpAvailability(server: AdminMcpServer): {
  audience: McpAudience;
  label: string;
  blocker: string | null;
} {
  const audience: McpAudience = !server.enabled || !server.isAllowed ? "off" : server.isPublished ? "members" : "test_users";
  if (server.mode === "proxy" && !server.upstreamUrl) {
    return { audience, label: "Setup incomplete", blocker: "Add an upstream URL." };
  }
  if (server.mode === "proxy" && server.credentialScope !== "personal" && server.upstreamAuthType !== "none" && !server.upstreamAuthConfigured) {
    return { audience, label: "Setup incomplete", blocker: "Add an authentication secret." };
  }
  if (!server.enabled || !server.isAllowed) {
    return {
      audience: "off",
      label: "Off",
      blocker: server.enabled && !server.isAllowed ? "Choose an audience to allow access." : null
    };
  }
  return server.isPublished
    ? { audience: "members", label: "Available to members", blocker: null }
    : { audience: "test_users", label: "Available to test users", blocker: null };
}

export function getMcpUpstreamWarnings(value: string): {
  http: boolean;
  privateNetwork: boolean;
} {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { http: false, privateNetwork: false };
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const octets = host.split(".");
  let privateNetwork: boolean;

  if (octets.length === 4 && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    const [a, b] = octets.map(Number);
    privateNetwork =
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && b === 168);
  } else {
    privateNetwork =
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      host.endsWith(".ts.net") ||
      (!host.includes(".") && !host.includes(":")) ||
      host === "::1" ||
      /^(?:fc|fd|fe[89ab])[0-9a-f]*:/i.test(host);
  }

  return { http: url.protocol === "http:", privateNetwork };
}

/** The part of the MCP form that decides where an organization secret goes. */
export type McpSecretTarget = {
  mode: "managed" | "proxy";
  upstreamUrl: string;
  upstreamAuthType: AdminMcpServer["upstreamAuthType"];
  upstreamAuthName: string;
  credentialScope: "organization" | "personal";
};

function urlOrigin(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** The draft fields that the review of a newer saved version shows. */
export type McpReviewDraft = McpSecretTarget & {
  serverName: string;
  description: string;
  routePath: string;
  upstreamAuthSecret: string;
  audience: McpAudience;
};

export type McpReviewRow = { setting: string; saved: string; draft: string };

const AUTH_LABEL: Record<AdminMcpServer["upstreamAuthType"], string> = {
  none: "None", bearer: "Bearer token", header: "Custom header", query: "Query parameter"
};
const SCOPE_LABEL = { organization: "Organization account", personal: "Each member connects" } as const;
const AUDIENCE_LABEL: Record<McpAudience, string> = { off: "Off", test_users: "Test users", members: "All members" };

/**
 * The settings that a newer saved version changed after the draft opened its
 * version: the newer value and the value that a save of the draft sends. A
 * secret row tells only whether a secret is saved or typed, never the secret.
 */
export function mcpReviewRows(opened: AdminMcpServer, saved: AdminMcpServer, draft: McpReviewDraft): McpReviewRow[] {
  const or = (value: string | null | undefined, empty: string) => value || empty;
  const proxy = draft.mode === "proxy";
  const authType = proxy ? draft.upstreamAuthType : "none";
  const scope = proxy ? draft.credentialScope : "organization";
  const named = authType === "header" || authType === "query";
  const settings: Array<[string, (server: AdminMcpServer) => string, string]> = [
    ["Name", (server) => server.serverName, draft.serverName],
    ["Description", (server) => or(server.description, "No description"), or(draft.description, "No description")],
    ["Mode", (server) => server.mode === "proxy" ? "Proxy" : "Managed", proxy ? "Proxy" : "Managed"],
    ["Route path", (server) => server.routePath, draft.routePath],
    ["URL", (server) => or(server.upstreamUrl, "None"), proxy ? or(draft.upstreamUrl, "None") : "None"],
    ["Account", (server) => SCOPE_LABEL[server.credentialScope ?? "organization"], SCOPE_LABEL[scope]],
    ["Upstream authentication", (server) => AUTH_LABEL[server.upstreamAuthType], AUTH_LABEL[authType]],
    ["Header or parameter name", (server) => or(server.upstreamAuthName, "None"), named ? or(draft.upstreamAuthName, "None") : "None"],
    ["Secret", (server) => server.upstreamAuthConfigured ? "Saved" : "Not saved",
      scope === "organization" && authType !== "none" && draft.upstreamAuthSecret ? "New secret entered" : "No new secret"],
    ["Availability", (server) => AUDIENCE_LABEL[getMcpAvailability(server).audience], AUDIENCE_LABEL[draft.audience]]
  ];
  return settings
    .filter(([, read]) => read(opened) !== read(saved))
    .map(([setting, read, draftValue]) => ({ setting, saved: read(saved), draft: draftValue }));
}

/**
 * True when an edit sends the saved organization secret to another origin, or by
 * another auth method. The backend then refuses a blank secret, so the form asks
 * for it again (mcp-server-store.ts, MCP_SECRET_REENTRY_MESSAGE).
 */
export function mustReenterMcpSecret(saved: AdminMcpServer | undefined, draft: McpSecretTarget): boolean {
  if (!saved || !saved.upstreamAuthConfigured || (saved.credentialScope ?? "organization") !== "organization") return false;
  if (draft.mode !== "proxy" || draft.credentialScope !== "organization" || draft.upstreamAuthType === "none") return false;
  const named = draft.upstreamAuthType === "header" || draft.upstreamAuthType === "query";
  return urlOrigin(draft.upstreamUrl) !== urlOrigin(saved.upstreamUrl) ||
    draft.upstreamAuthType !== saved.upstreamAuthType ||
    (named && draft.upstreamAuthName !== (saved.upstreamAuthName ?? ""));
}
