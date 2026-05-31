import { test, expect } from "vitest";

import { SkillMarketplaceService } from "./skill-marketplace-service.js";
import { createTestConfig } from "../../test-helpers/test-config.js";

test("skill marketplace service returns disabled when no manifest is configured", async () => {
  const service = new SkillMarketplaceService(
    createTestConfig({ SKILL_MARKETPLACE_MANIFEST_URL: undefined })
  );

  const catalog = await service.getCatalog();

  expect(catalog.status).toBe("disabled");
  expect(catalog.skills.length).toBe(0);
});

test("skill marketplace service normalizes repository defaults from the manifest", async () => {
  const service = new SkillMarketplaceService(
    createTestConfig({
      SKILL_MARKETPLACE_MANIFEST_URL: "https://example.com/marketplace.json",
      SKILL_MARKETPLACE_CACHE_TTL_MS: 60_000
    }),
    async () =>
      new Response(
        JSON.stringify({
          version: 1,
          title: "Reviewed Agent Skills",
          description: "Curated skills for onboarding.",
          repositoryUrl: "https://github.com/example-org/agent-skills-marketplace",
          ref: "9f3c2d8f6b4d8f1c2a",
          skills: [
            {
              slug: "meeting-brief",
              name: "Meeting Brief",
              description: "Create decisions, actions, and risks from meeting notes.",
              subdirectory: "skills/meeting-brief",
              reviewStatus: "reviewed",
              recommended: true,
              tags: ["onboarding"]
            }
          ]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      )
  );

  const catalog = await service.getCatalog();

  expect(catalog.status).toBe("ready");
  expect(catalog.repositoryUrl).toBe("https://github.com/example-org/agent-skills-marketplace");
  expect(catalog.skills[0]?.repositoryUrl).toBe("https://github.com/example-org/agent-skills-marketplace");
  expect(catalog.skills[0]?.ref).toBe("9f3c2d8f6b4d8f1c2a");
  expect(catalog.skills[0]?.sourceUrl).toBe("https://github.com/example-org/agent-skills-marketplace/tree/9f3c2d8f6b4d8f1c2a/skills/meeting-brief");
});

test("fetches org manifest with Authorization header when token provided", async () => {
  let capturedHeaders: Record<string, string> = {};

  const service = new SkillMarketplaceService(
    createTestConfig({ SKILL_MARKETPLACE_MANIFEST_URL: undefined }),
    async (url, init) => {
      capturedHeaders = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>)
      );
      return new Response(
        JSON.stringify({
          version: 1,
          repositoryUrl: "https://github.com/acme/private-skills",
          ref: "main",
          skills: [
            {
              slug: "internal-tool",
              name: "Internal Tool",
              description: "A private internal skill.",
              subdirectory: "skills/internal-tool",
              reviewStatus: "reviewed"
            }
          ]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
  );

  const catalog = await service.getCatalog({
    manifestUrl: "https://api.github.com/repos/acme/private-skills/contents/manifest.json",
    githubToken: "ghs_test_token_abc"
  });

  expect(catalog.status).toBe("ready");
  expect(catalog.skills.length).toBe(1);
  expect(capturedHeaders["Authorization"]).toBe("Bearer ghs_test_token_abc");
});

test("does not send GitHub token to non-GitHub marketplace manifest URLs", async () => {
  let capturedHeaders: Record<string, string> = {};

  const service = new SkillMarketplaceService(
    createTestConfig({ SKILL_MARKETPLACE_MANIFEST_URL: undefined }),
    async (_url, init) => {
      capturedHeaders = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>)
      );
      return new Response(
        JSON.stringify({
          version: 1,
          repositoryUrl: "https://github.com/acme/private-skills",
          ref: "main",
          skills: [
            {
              slug: "internal-tool",
              name: "Internal Tool",
              description: "A private internal skill.",
              subdirectory: "skills/internal-tool",
              reviewStatus: "reviewed"
            }
          ]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
  );

  const catalog = await service.getCatalog({
    manifestUrl: "https://example.com/marketplace.json",
    githubToken: "ghs_test_token_abc"
  });

  expect(catalog.status).toBe("ready");
  expect(catalog.skills.length).toBe(1);
  expect(capturedHeaders["Authorization"]).toBe(undefined);
});

test("skill marketplace service reports manifest validation failures as catalog errors", async () => {
  const service = new SkillMarketplaceService(
    createTestConfig({
      SKILL_MARKETPLACE_MANIFEST_URL: "https://example.com/marketplace.json"
    }),
    async () =>
      new Response(
        JSON.stringify({
          version: 1,
          skills: [
            {
              slug: "bad-entry"
            }
          ]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      )
  );

  const catalog = await service.getCatalog();

  expect(catalog.status).toBe("error");
  expect(catalog.skills).toEqual([]);
  // The manifest entry omits `name`, `description`, and `subdirectory`; every
  // omitted required field must surface in the catalog error so the operator
  // can see all of them, not just whichever one validation happens to report
  // first.
  const error = catalog.error ?? "";
  expect(error).toContain("name");
  expect(error).toContain("description");
  expect(error).toContain("subdirectory");
});
