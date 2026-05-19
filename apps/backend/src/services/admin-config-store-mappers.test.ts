import { test, expect, describe } from "vitest";

import {
  mapMcpServer,
  mapSkill,
  mapSkillRevision,
  mapTenantMember,
  parseApprovalPolicy,
  parseApprovalReviewer,
  parseSkillActivationMetadata
} from "./admin-config-store-mappers.js";

describe("parseApprovalPolicy", () => {
  test("returns 'never' for the literal 'never'", () => {
    expect(parseApprovalPolicy("never")).toBe("never");
  });

  test("returns 'on-request' for the literal 'on-request'", () => {
    expect(parseApprovalPolicy("on-request")).toBe("on-request");
  });

  test("parses a JSON-encoded granular policy", () => {
    const granular = { granular: { writeFile: "on-request", runCommand: "never" } };
    expect(parseApprovalPolicy(JSON.stringify(granular))).toEqual(granular);
  });

  test("falls back to 'never' for invalid JSON", () => {
    expect(parseApprovalPolicy("{not-json")).toBe("never");
  });

  test("falls back to 'never' for JSON without a 'granular' key", () => {
    expect(parseApprovalPolicy(JSON.stringify({ foo: "bar" }))).toBe("never");
  });

  test("falls back to 'never' for non-string, non-recognized values", () => {
    expect(parseApprovalPolicy(null)).toBe("never");
    expect(parseApprovalPolicy(undefined)).toBe("never");
    expect(parseApprovalPolicy(42)).toBe("never");
    expect(parseApprovalPolicy({})).toBe("never");
  });
});

describe("parseApprovalReviewer", () => {
  test("returns 'guardian_subagent' when explicitly set", () => {
    expect(parseApprovalReviewer("guardian_subagent")).toBe("guardian_subagent");
  });

  test("defaults to 'user' for any other value", () => {
    expect(parseApprovalReviewer("user")).toBe("user");
    expect(parseApprovalReviewer(null)).toBe("user");
    expect(parseApprovalReviewer(undefined)).toBe("user");
    expect(parseApprovalReviewer("unknown")).toBe("user");
  });
});

describe("parseSkillActivationMetadata", () => {
  test("returns ok for fully populated metadata", () => {
    const result = parseSkillActivationMetadata({
      skillName: "my-skill",
      description: "Does the thing",
      instructions: "Step 1: do the thing."
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      skillName: "my-skill",
      description: "Does the thing",
      instructions: "Step 1: do the thing."
    });
  });

  test("treats missing description as null without failing", () => {
    const result = parseSkillActivationMetadata({
      skillName: "my-skill",
      instructions: "Step 1"
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.description).toBeNull();
  });

  test("treats non-string description as null", () => {
    const result = parseSkillActivationMetadata({
      skillName: "my-skill",
      instructions: "Step 1",
      description: 42 // wrong type
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.description).toBeNull();
  });

  test("returns missing=['skillName'] when skillName is absent", () => {
    const result = parseSkillActivationMetadata({ instructions: "step 1" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toEqual(["skillName"]);
  });

  test("returns missing=['instructions'] when instructions is absent", () => {
    const result = parseSkillActivationMetadata({ skillName: "x" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toEqual(["instructions"]);
  });

  test("returns both fields when both are absent", () => {
    const result = parseSkillActivationMetadata({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toEqual(["skillName", "instructions"]);
  });

  test("non-string skillName triggers missing", () => {
    const result = parseSkillActivationMetadata({ skillName: 1, instructions: "x" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toContain("skillName");
  });
});

describe("mapSkill", () => {
  function makeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      tenant_id: "system",
      skill_id: "write-artifact",
      skill_name: "Write Artifact",
      description: "Persists generated files",
      instructions: "Call write_artifact",
      version: 3,
      content_hash: "deadbeef",
      enabled: true,
      is_published: true,
      created_by: "user-1",
      created_at: "2026-04-01T00:00:00.000Z",
      updated_at: "2026-04-02T00:00:00.000Z",
      active_revision_id: 7,
      active_source_type: "inline",
      active_bundle_name: null,
      active_bundle_storage_uri: null,
      active_bundle_hash: null,
      active_validation_status: "passed",
      active_review_status: "approved",
      active_associated_tool_ids: ["write_artifact"],
      ...overrides
    };
  }

  test("maps a fully populated row", () => {
    const skill = mapSkill(makeRow(), "tenant-a");
    expect(skill.skillId).toBe("write-artifact");
    expect(skill.skillName).toBe("Write Artifact");
    expect(skill.description).toBe("Persists generated files");
    expect(skill.version).toBe(3);
    expect(skill.activeRevisionId).toBe(7);
    expect(skill.associatedToolIds).toEqual(["write_artifact"]);
    expect(skill.createdAt).toBe("2026-04-01T00:00:00.000Z");
  });

  test("isInherited true when tenant is 'system' and request is from a different tenant", () => {
    expect(mapSkill(makeRow({ tenant_id: "system" }), "tenant-a").isInherited).toBe(true);
  });

  test("isInherited false when system tenant requests its own skill", () => {
    expect(mapSkill(makeRow({ tenant_id: "system" }), "system").isInherited).toBe(false);
  });

  test("isInherited false when no requestTenantId provided", () => {
    expect(mapSkill(makeRow({ tenant_id: "system" }), undefined).isInherited).toBe(false);
  });

  test("isInherited false for tenant-owned skills", () => {
    expect(mapSkill(makeRow({ tenant_id: "tenant-a" }), "tenant-a").isInherited).toBe(false);
  });

  test("nullable fields map to null when source is null", () => {
    const skill = mapSkill(
      makeRow({
        description: null,
        active_revision_id: null,
        active_source_type: null,
        active_bundle_name: null,
        active_bundle_storage_uri: null,
        active_bundle_hash: null,
        active_validation_status: null,
        active_review_status: null,
        active_associated_tool_ids: null
      })
    );
    expect(skill.description).toBeNull();
    expect(skill.activeRevisionId).toBeNull();
    expect(skill.activeSourceType).toBeNull();
    expect(skill.activeBundleName).toBeNull();
    expect(skill.associatedToolIds).toEqual([]);
  });

  test("filters non-string entries from associated tool ids", () => {
    const skill = mapSkill(
      makeRow({ active_associated_tool_ids: ["good", 42, null, "also-good"] })
    );
    expect(skill.associatedToolIds).toEqual(["good", "also-good"]);
  });
});

describe("mapSkillRevision", () => {
  function makeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      skill_revision_id: 11,
      skill_id: "write-artifact",
      revision_number: 4,
      source_type: "inline",
      source_label: null,
      bundle_name: null,
      bundle_storage_uri: null,
      bundle_hash: "abc123",
      validation_status: "passed",
      validation_messages: [],
      review_status: "approved",
      review_notes: null,
      metadata: { skillName: "Write Artifact" },
      created_by: "user-1",
      created_at: "2026-04-01T00:00:00.000Z",
      reviewed_by: null,
      reviewed_at: null,
      activated_at: null,
      ...overrides
    };
  }

  test("maps required fields", () => {
    const r = mapSkillRevision(makeRow());
    expect(r.skillRevisionId).toBe(11);
    expect(r.revisionNumber).toBe(4);
    expect(r.bundleHash).toBe("abc123");
    expect(r.metadata).toEqual({ skillName: "Write Artifact" });
  });

  test("converts reviewed_at and activated_at to ISO strings when present", () => {
    const r = mapSkillRevision(
      makeRow({
        reviewed_by: "reviewer-1",
        reviewed_at: "2026-04-05T10:00:00.000Z",
        activated_at: "2026-04-06T10:00:00.000Z"
      })
    );
    expect(r.reviewedBy).toBe("reviewer-1");
    expect(r.reviewedAt).toBe("2026-04-05T10:00:00.000Z");
    expect(r.activatedAt).toBe("2026-04-06T10:00:00.000Z");
  });

  test("filters non-object validation_messages entries", () => {
    const r = mapSkillRevision(
      makeRow({ validation_messages: [{ ok: true }, "string", null, { warn: 1 }] })
    );
    expect(r.validationMessages).toEqual([{ ok: true }, { warn: 1 }]);
  });

  test("returns empty object for non-object metadata", () => {
    const r = mapSkillRevision(makeRow({ metadata: null }));
    expect(r.metadata).toEqual({});
  });
});

describe("mapMcpServer", () => {
  function makeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      server_id: "github",
      server_name: "GitHub",
      description: "GitHub MCP server",
      mode: "managed",
      route_path: "/mcp/github",
      upstream_url: null,
      headers_allowlist: [],
      version: 1,
      config_hash: "h1",
      enabled: true,
      is_published: true,
      created_by: "user-1",
      created_at: "2026-04-01T00:00:00.000Z",
      updated_at: "2026-04-01T00:00:00.000Z",
      ...overrides
    };
  }

  test("maps managed mode", () => {
    const s = mapMcpServer(makeRow());
    expect(s.mode).toBe("managed");
    expect(s.transportKind).toBe("http");
    expect(s.upstreamUrl).toBeNull();
  });

  test("maps proxy mode and preserves upstreamUrl", () => {
    const s = mapMcpServer(
      makeRow({ mode: "proxy", upstream_url: "https://upstream.example/mcp" })
    );
    expect(s.mode).toBe("proxy");
    expect(s.upstreamUrl).toBe("https://upstream.example/mcp");
  });

  test("rejects unknown mode with descriptive error", () => {
    expect(() => mapMcpServer(makeRow({ mode: "weird" }))).toThrow(
      /Unknown MCP server mode: weird/
    );
  });

  test("filters non-string entries from headers allowlist", () => {
    const s = mapMcpServer(
      makeRow({ headers_allowlist: ["x-custom", 42, "x-other"] })
    );
    expect(s.headersAllowlist).toEqual(["x-custom", "x-other"]);
  });

  test("description null when source is null/empty", () => {
    expect(mapMcpServer(makeRow({ description: null })).description).toBeNull();
    expect(mapMcpServer(makeRow({ description: "" })).description).toBeNull();
  });
});

describe("mapTenantMember", () => {
  function makeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      user_id: "user-1",
      tenant_id: "tenant-a",
      email: "alice@example.com",
      display_name: "Alice",
      role: "owner",
      is_beta_tester: true,
      created_at: "2026-04-01T00:00:00.000Z",
      updated_at: "2026-04-01T00:00:00.000Z",
      ...overrides
    };
  }

  test("maps a fully populated row", () => {
    const m = mapTenantMember(makeRow());
    expect(m.userId).toBe("user-1");
    expect(m.role).toBe("owner");
    expect(m.email).toBe("alice@example.com");
    expect(m.isBetaTester).toBe(true);
  });

  test.each(["owner", "admin", "member"] as const)(
    "accepts role '%s'",
    (role) => {
      expect(mapTenantMember(makeRow({ role })).role).toBe(role);
    }
  );

  test("rejects unknown role with descriptive error", () => {
    expect(() => mapTenantMember(makeRow({ role: "godking" }))).toThrow(
      /Unknown membership role: godking/
    );
  });

  test("nullable email and display name", () => {
    const m = mapTenantMember(makeRow({ email: null, display_name: null }));
    expect(m.email).toBeNull();
    expect(m.displayName).toBeNull();
  });
});
