import { describe, it, expect } from "vitest";
import {
  AdminMcpServerCreateRequestSchema,
  AdminMcpServerUpdateRequestSchema
} from "@cogniplane/shared-types";

import {
  mcpCreateBodySchema,
  mcpUpdateBodySchema,
  githubImportBodySchema,
  inlineSkillImportBodySchema,
  tenantSettingsBodySchema
} from "./admin-route-schemas.js";

const validBase = {
  serverName: "test",
  mode: "proxy" as const,
  routePath: "/mcp/test"
};

describe.each([
  ["create", AdminMcpServerCreateRequestSchema, mcpCreateBodySchema],
  ["update", AdminMcpServerUpdateRequestSchema, mcpUpdateBodySchema]
])("MCP %s URL validation", (_operation, sharedSchema, routeSchema) => {
  it("accepts HTTP and private MCP upstreams while rejecting URL credentials", () => {
    const body = { ...validBase, serverId: "test" };
    expect(sharedSchema.safeParse({ ...body, upstreamUrl: "not a URL" }).success).toBe(false);
    for (const upstreamUrl of [
      "http://example.com/mcp",
      "http://100.108.24.234:3108/mcp",
      "http://10.0.4.17/mcp",
      "https://127.0.0.1/mcp",
      "http://localhost:3108/mcp"
    ]) {
      expect(sharedSchema.safeParse({ ...body, upstreamUrl }).success).toBe(true);
      expect(routeSchema.safeParse({ ...body, upstreamUrl }).success).toBe(true);
    }
    for (const upstreamUrl of [
      "https://user:password@example.com/mcp",
      "http://example.com/mcp?api_key=secret",
      "file:///etc/passwd"
    ]) {
      expect(routeSchema.safeParse({ ...body, upstreamUrl }).success).toBe(false);
    }
  });

  it("rejects an upstream URL in managed mode", () => {
    expect(routeSchema.safeParse({
      ...validBase,
      serverId: "managed",
      mode: "managed",
      upstreamUrl: "http://100.108.24.234:3108/mcp"
    }).success).toBe(false);
  });
});

describe("httpsUrlSchema on GitHub imports", () => {
  const blocked: Array<[string, string]> = [
    ["loopback IPv4", "https://127.0.0.1/"],
    ["loopback IPv4 alt", "https://127.1.2.3/"],
    ["AWS IMDS link-local", "https://169.254.169.254/latest/meta-data/"],
    ["RFC 1918 10/8", "https://10.0.0.1/"],
    ["RFC 1918 172.16/12", "https://172.16.0.1/"],
    ["RFC 1918 172.31/12", "https://172.31.255.254/"],
    ["RFC 1918 192.168/16", "https://192.168.1.1/"],
    ["shared address 100.64/10", "https://100.64.0.1/"],
    ["unspecified 0.0.0.0", "https://0.0.0.0/"],
    ["broadcast 255.255.255.255", "https://255.255.255.255/"],
    ["IPv6 loopback ::1", "https://[::1]/"],
    ["IPv6 unspecified ::", "https://[::]/"],
    ["IPv6 unique-local fc::", "https://[fc00::1]/"],
    ["IPv6 unique-local fd::", "https://[fd12:3456::1]/"],
    ["IPv6 link-local fe80::", "https://[fe80::1]/"]
  ];

  for (const [label, url] of blocked) {
    it(`rejects ${label}: ${url}`, () => {
      const result = githubImportBodySchema.safeParse({ githubUrl: url });
      expect(result.success).toBe(false);
    });
  }

  it("accepts a valid external HTTPS URL", () => {
    const result = githubImportBodySchema.safeParse({ githubUrl: "https://api.example.com/repo" });
    expect(result.success).toBe(true);
  });

  it("accepts null upstreamUrl (optional field)", () => {
    const result = mcpUpdateBodySchema.safeParse({ ...validBase, upstreamUrl: null });
    expect(result.success).toBe(true);
  });

  it("rejects http:// scheme", () => {
    const result = githubImportBodySchema.safeParse({ githubUrl: "http://api.example.com/repo" });
    expect(result.success).toBe(false);
  });

  it("githubImportBodySchema also rejects private IPs", () => {
    const result = githubImportBodySchema.safeParse({
      githubUrl: "https://192.168.0.1/owner/repo"
    });
    expect(result.success).toBe(false);
  });
});

describe("httpsUrlSchema on GitHub imports — IPv4 numeric-format bypass", () => {
  // Each of these resolves to 127.0.0.1 via the OS resolver but evades a
  // naive dotted-decimal check. The hardened guard treats numeric-shaped
  // hostnames that aren't canonical IPv4 as private/reserved.
  const bypassed: Array<[string, string]> = [
    ["octal-prefixed octet", "https://0177.0.0.1/"],
    ["32-bit integer form", "https://2130706433/"],
    ["hex-prefixed octet", "https://0x7f.0.0.1/"],
    ["short 2-segment form", "https://127.1/"],
    ["short 3-segment form", "https://127.0.1/"],
    ["full hex form", "https://0x7f000001/"],
    ["octal IMDS bypass", "https://0251.0376.0251.0376/"]
  ];

  for (const [label, url] of bypassed) {
    it(`rejects ${label}: ${url}`, () => {
      const result = githubImportBodySchema.safeParse({ githubUrl: url });
      expect(result.success).toBe(false);
    });
  }

  it("rejects octets greater than 255", () => {
    const result = githubImportBodySchema.safeParse({ githubUrl: "https://999.0.0.1/" });
    expect(result.success).toBe(false);
  });

  it("still accepts canonical external IPv4 addresses", () => {
    const result = githubImportBodySchema.safeParse({ githubUrl: "https://8.8.8.8/" });
    expect(result.success).toBe(true);
  });

  it("still accepts normal hostnames containing the letter x", () => {
    const result = githubImportBodySchema.safeParse({ githubUrl: "https://x.example.com/repo" });
    expect(result.success).toBe(true);
  });
});

describe("MCP request schemas", () => {
  it("requires serverId for create but not update", () => {
    expect(mcpCreateBodySchema.safeParse(validBase).success).toBe(false);
    expect(mcpCreateBodySchema.safeParse({ ...validBase, serverId: "test" }).success).toBe(true);
    expect(mcpUpdateBodySchema.safeParse(validBase).success).toBe(true);
  });

  it("applies transport and enabled defaults to both operations", () => {
    const created = mcpCreateBodySchema.parse({ ...validBase, serverId: "test" });
    const updated = mcpUpdateBodySchema.parse(validBase);

    expect(created).toMatchObject({ transportKind: "http", enabled: true });
    expect(updated).toMatchObject({ transportKind: "http", enabled: true });
  });
});

describe("tenantSettingsBodySchema", () => {
  it("accepts the Policy Center enforcement mode", () => {
    const result = tenantSettingsBodySchema.safeParse({
      policyEnforcementMode: "enforce"
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.policyEnforcementMode).toBe("enforce");
    }
  });

  it("rejects unknown Policy Center enforcement modes", () => {
    const result = tenantSettingsBodySchema.safeParse({
      policyEnforcementMode: "dry-run"
    });

    expect(result.success).toBe(false);
  });
});


describe("MCP credential ownership", () => {
  it("defaults new connections to organization credentials and preserves omitted edits", () => {
    expect(mcpCreateBodySchema.parse({ ...validBase, serverId: "docs" }).credentialScope).toBe("organization");
    expect(mcpUpdateBodySchema.parse(validBase).credentialScope).toBeUndefined();
    const personal = mcpCreateBodySchema.parse({ ...validBase, serverId: "docs", credentialScope: "personal",
      upstreamAuthType: "bearer", upstreamUrl: "https://example.test/mcp" });
    expect(personal.credentialScope).toBe("personal");
    expect(personal.upstreamAuthSecret).toBeUndefined();
    expect(mcpUpdateBodySchema.safeParse({ ...validBase, credentialScope: "creator" }).success).toBe(false);
  });
});

describe("inlineSkillImportBodySchema", () => {
  const body = (skillName: string) => ({ skillId: "notes", skillName, description: "d", instructions: "i" });

  it("accepts a 64-character name and rejects a longer one", () => {
    // organization_skill_author_updates.skill_name allows 64 characters, so a
    // longer name would fail with a 500 when an edited submission is released.
    expect(inlineSkillImportBodySchema.safeParse(body("a".repeat(64))).success).toBe(true);
    expect(inlineSkillImportBodySchema.safeParse(body("a".repeat(65))).success).toBe(false);
  });
});
