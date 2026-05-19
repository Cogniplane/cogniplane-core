import { test, expect } from "vitest";

import { CodexSkillDiscoveryService } from "./codex-skill-discovery-service.js";

class FakeProcess {
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  response: unknown = {
    data: [
      {
        cwd: "/tmp/workspace",
        errors: [],
        skills: [
          {
            name: "pdf-processing",
            path: "/tmp/workspace/.codex/skills/pdf-processing"
          }
        ]
      }
    ]
  };

  async sendRequest<T>(method: string, params: Record<string, unknown>): Promise<T> {
    this.requests.push({ method, params });
    if (method === "skills/config/write") {
      return {} as T;
    }
    if (method === "skills/list") {
      return this.response as T;
    }
    throw new Error(`Unexpected method: ${method}`);
  }
}

test("CodexSkillDiscoveryService enables and verifies installed skills", async () => {
  const process = new FakeProcess();
  const service = new CodexSkillDiscoveryService();

  const result = await service.verifyInstalledSkills({
    process,
    workspacePath: "/tmp/workspace",
    skills: [
      {
        id: "pdf-processing",
        path: "/tmp/workspace/.codex/skills/pdf-processing",
        sourceType: "github"
      }
    ]
  });

  expect(process.requests[0]?.method).toBe("skills/config/write");
  expect(process.requests[1]?.method).toBe("skills/list");
  expect(result.discoveredSkillNames[0]).toBe("pdf-processing");
});

test("CodexSkillDiscoveryService returns empty when there are no source-type skills to verify", async () => {
  const process = new FakeProcess();
  const service = new CodexSkillDiscoveryService();
  const result = await service.verifyInstalledSkills({
    process,
    workspacePath: "/tmp/workspace",
    // sourceType=null filters everything out (inline skills)
    skills: [{ id: "x", path: "/x", sourceType: null }]
  });
  expect(process.requests.length).toBe(0);
  expect(result.discoveredSkillNames).toEqual([]);
  expect(result.skillDiscoveryErrors).toEqual([]);
});

test("CodexSkillDiscoveryService surfaces errors from the workspace entry", async () => {
  const process = new FakeProcess();
  process.response = {
    data: [
      {
        cwd: "/tmp/workspace",
        errors: [{ path: "/skill", message: "broken yaml" }],
        skills: []
      }
    ]
  };
  const service = new CodexSkillDiscoveryService();
  await expect(service.verifyInstalledSkills({
        process,
        workspacePath: "/tmp/workspace",
        skills: [{ id: "x", path: "/tmp/workspace/.codex/skills/x", sourceType: "github" }]
      })).rejects.toThrow(/failed discovery: \/skill: broken yaml/);
});

test("CodexSkillDiscoveryService falls back to the first entry when cwd does not match", async () => {
  const process = new FakeProcess();
  process.response = {
    data: [
      // No entry whose cwd matches /tmp/workspace; fallback uses entries[0]
      {
        cwd: "/tmp/other",
        errors: [],
        skills: [{ name: "x", path: "/tmp/other/.codex/skills/x" }]
      }
    ]
  };
  const service = new CodexSkillDiscoveryService();
  const result = await service.verifyInstalledSkills({
    process,
    workspacePath: "/tmp/workspace",
    skills: [{ id: "x", path: "/tmp/workspace/.codex/skills/x", sourceType: "github" }]
  });
  // The entry was used and 'x' is discovered.
  expect(result.discoveredSkillNames).toEqual(["x"]);
});

test("CodexSkillDiscoveryService accepts skill paths ending in /SKILL.md by walking up one segment", async () => {
  const process = new FakeProcess();
  process.response = {
    data: [
      {
        cwd: "/tmp/workspace",
        errors: [],
        skills: [
          { name: "y", path: "/tmp/workspace/.codex/skills/y/SKILL.md" }
        ]
      }
    ]
  };
  const service = new CodexSkillDiscoveryService();
  const result = await service.verifyInstalledSkills({
    process,
    workspacePath: "/tmp/workspace",
    skills: [{ id: "y", path: "/tmp/workspace/.codex/skills/y", sourceType: "github" }]
  });
  // 'y' satisfies the expected directoryName even though Codex returned the
  // SKILL.md file path instead of the directory.
  expect(result.discoveredSkillNames).toEqual(["y"]);
});

test("CodexSkillDiscoveryService treats missing data array as empty (no errors, no discoveries)", async () => {
  const process = new FakeProcess();
  process.response = {}; // no data
  const service = new CodexSkillDiscoveryService();
  await expect(service.verifyInstalledSkills({
        process,
        workspacePath: "/tmp/workspace",
        skills: [{ id: "x", path: "/tmp/workspace/.codex/skills/x", sourceType: "github" }]
      })).rejects.toThrow(/not discoverable through Codex: x/);
});

test("CodexSkillDiscoveryService falls back to path or 'unknown' when name is missing on a discovered skill", async () => {
  const process = new FakeProcess();
  process.response = {
    data: [
      {
        cwd: "/tmp/workspace",
        errors: [],
        skills: [
          { path: "/tmp/workspace/.codex/skills/z" }, // no name
          {} // no name and no path -> 'unknown'
        ]
      }
    ]
  };
  const service = new CodexSkillDiscoveryService();
  const result = await service.verifyInstalledSkills({
    process,
    workspacePath: "/tmp/workspace",
    skills: [{ id: "z", path: "/tmp/workspace/.codex/skills/z", sourceType: "github" }]
  });
  expect(result.discoveredSkillNames).toEqual(["/tmp/workspace/.codex/skills/z", "unknown"]);
});

test("CodexSkillDiscoveryService fails when an installed skill is missing", async () => {
  const process = new FakeProcess();
  process.response = {
    data: [{ cwd: "/tmp/workspace", errors: [], skills: [] }]
  };
  const service = new CodexSkillDiscoveryService();

  await expect(service.verifyInstalledSkills({
        process,
        workspacePath: "/tmp/workspace",
        skills: [
          {
            id: "pdf-processing",
            path: "/tmp/workspace/.codex/skills/pdf-processing",
            sourceType: "github"
          }
        ]
      })).rejects.toThrow(/not discoverable through Codex/);
});
