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
  if (server.mode === "proxy" && !server.upstreamUrl) {
    return { audience: "off", label: "Setup incomplete", blocker: "Add an upstream URL." };
  }
  if (server.upstreamAuthType !== "none" && !server.upstreamAuthConfigured) {
    return { audience: "off", label: "Setup incomplete", blocker: "Add an authentication secret." };
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
