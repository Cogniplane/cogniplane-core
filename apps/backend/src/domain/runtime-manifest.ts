export type RuntimeManifestConfigSources = {
  runtimePolicy: {
    id: string;
    version: number;
    hash: string;
  };
  skills: Array<{
    id: string;
    version: number;
    hash: string;
    revisionId: number | null;
    bundleHash: string | null;
  }>;
  mcpServers: Array<{
    id: string;
    version: number;
    hash: string;
  }>;
};

export type RuntimeManifestSkillEntry = {
  id: string;
  name: string;
  version: number;
  hash: string;
  revisionId: number | null;
  bundleHash: string;
  path: string;
  sourceType: string | null;
};

export type RuntimeManifestMcpServerEntry = {
  id: string;
  version: number;
  hash: string;
  mode: string;
  url: string;
};

export type RuntimeManifest = {
  manifestVersion: string;
  manifestHash: string;
  configBundleHash: string;
  sessionId: string;
  userId: string;
  generatedAt: string;
  workspacePath: string;
  codex: {
    binaryPath: string;
    version: string;
    schemaVersion: string;
    model: string;
  };
  runtimePolicy: {
    id: string;
    version: number;
    hash: string;
    approvalPolicy: string;
    sandboxMode: string;
    networkMode: string;
    allowCommandExecution: boolean;
    allowUserTokenForwarding: boolean;
    autoApproveReadOnlyTools: boolean;
    enabledToolIds: string[];
  };
  skills: RuntimeManifestSkillEntry[];
  mcpServers: RuntimeManifestMcpServerEntry[];
  configSources: RuntimeManifestConfigSources;
  config: {
    codexTomlPath: string;
    skillsPath: string;
    customSkillsEnabled: boolean;
    customMcpServersEnabled: boolean;
  };
};

export type RuntimeConfigSummary = {
  manifestHash: string;
  configBundleHash: string;
  runtimePolicy: {
    id: string;
    version: number;
    hash: string;
  };
  skillVersions: RuntimeManifestConfigSources["skills"];
  mcpServerVersions: RuntimeManifestConfigSources["mcpServers"];
};

export function summarizeRuntimeConfig(manifest: RuntimeManifest): RuntimeConfigSummary {
  return {
    manifestHash: manifest.manifestHash,
    configBundleHash: manifest.configBundleHash,
    runtimePolicy: {
      id: manifest.configSources.runtimePolicy.id,
      version: manifest.configSources.runtimePolicy.version,
      hash: manifest.configSources.runtimePolicy.hash
    },
    skillVersions: manifest.configSources.skills,
    mcpServerVersions: manifest.configSources.mcpServers
  };
}
