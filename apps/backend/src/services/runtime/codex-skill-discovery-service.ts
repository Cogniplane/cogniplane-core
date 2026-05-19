type RuntimeProcessLike = {
  sendRequest<T>(method: string, params: Record<string, unknown>): Promise<T>;
};

type InstalledSkill = {
  id: string;
  path: string;
  sourceType: string | null;
};

type SkillsListResponse = {
  data?: Array<{
    cwd?: string;
    errors?: Array<{
      message?: string;
      path?: string;
    }>;
    skills?: Array<{
      name?: string;
      path?: string;
      enabled?: boolean;
      scope?: string;
    }>;
  }>;
};

export type SkillDiscoveryResult = {
  verifiedAt: string;
  discoveredSkillNames: string[];
  skillDiscoveryErrors: string[];
};

export class CodexSkillDiscoveryService {
  async verifyInstalledSkills(input: {
    process: RuntimeProcessLike;
    workspacePath: string;
    skills: InstalledSkill[];
  }): Promise<SkillDiscoveryResult> {
    const expectedBundleSkills = input.skills
      .filter((skill) => skill.sourceType)
      .map((skill) => ({
        skillId: skill.id,
        path: skill.path,
        directoryName: skill.path.split("/").pop() ?? skill.path
      }));

    const verifiedAt = new Date().toISOString();
    if (!expectedBundleSkills.length) {
      return {
        verifiedAt,
        discoveredSkillNames: [],
        skillDiscoveryErrors: []
      };
    }

    await Promise.all(
      expectedBundleSkills.map(async (skill) => {
        await input.process.sendRequest("skills/config/write", {
          path: skill.path,
          enabled: true
        });
      })
    );

    const response = (await input.process.sendRequest("skills/list", {
      cwds: [input.workspacePath],
      forceReload: true
    })) as SkillsListResponse;
    const entries = Array.isArray(response.data) ? response.data : [];
    const workspaceEntry =
      entries.find((entry) => entry.cwd === input.workspacePath) ?? entries[0] ?? { errors: [], skills: [] };
    const skillDiscoveryErrors = Array.isArray(workspaceEntry.errors)
      ? workspaceEntry.errors.map(
          (error) => `${error.path ?? input.workspacePath}: ${error.message ?? "Unknown error"}`
        )
      : [];

    if (skillDiscoveryErrors.length) {
      throw new Error(`Installed skills failed discovery: ${skillDiscoveryErrors.join("; ")}`);
    }

    const discoveredSkills = Array.isArray(workspaceEntry.skills) ? workspaceEntry.skills : [];
    const discoveredDirectoryNames = new Set(
      discoveredSkills
        .map((skill) => {
          const parts = skill.path?.split("/").filter((p) => p.length > 0);
          if (!parts || parts.length === 0) return undefined;
          // Codex may return either the directory path or the path to SKILL.md
          const last = parts[parts.length - 1];
          return last === "SKILL.md" ? parts[parts.length - 2] : last;
        })
        .filter((value): value is string => typeof value === "string" && value.length > 0)
    );
    const missingSkills = expectedBundleSkills
      .filter((skill) => !discoveredDirectoryNames.has(skill.directoryName))
      .map((skill) => skill.skillId);

    if (missingSkills.length) {
      throw new Error(
        `Installed skills are not discoverable through Codex: ${missingSkills.join(", ")}`
      );
    }

    return {
      verifiedAt,
      discoveredSkillNames: discoveredSkills.map((skill) => skill.name ?? skill.path ?? "unknown"),
      skillDiscoveryErrors: []
    };
  }
}
