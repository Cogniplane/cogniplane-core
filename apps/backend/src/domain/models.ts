import type { RuntimeReasoningEffort } from "../runtime-contracts.js";
import type { RuntimeProvider } from "../services/admin-config-records.js";

export const AVAILABLE_MODELS: readonly {
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  provider: RuntimeProvider;
  supportedEfforts: RuntimeReasoningEffort[];
  defaultEffort: RuntimeReasoningEffort | null;
}[] = [
  { id: "gpt-5.5",             displayName: "gpt-5.5",             description: "Latest frontier agentic coding model.", isDefault: false, provider: "codex", supportedEfforts: ["none", "low", "medium", "high", "xhigh"], defaultEffort: "none" },
  { id: "gpt-5.4",            displayName: "gpt-5.4",            description: "Latest frontier agentic coding model.", isDefault: false, provider: "codex", supportedEfforts: ["none", "low", "medium", "high", "xhigh"], defaultEffort: "none" },
  { id: "gpt-5.4-mini",       displayName: "gpt-5.4-mini",       description: "Smaller frontier agentic coding model.", isDefault: true,  provider: "codex", supportedEfforts: ["none", "low", "medium", "high", "xhigh"], defaultEffort: "none" },
  { id: "gpt-5.3-codex",      displayName: "gpt-5.3-codex",      description: "Frontier Codex-optimized agentic coding model.", isDefault: false, provider: "codex", supportedEfforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" },
  { id: "gpt-5.2-codex",      displayName: "gpt-5.2-codex",      description: "Frontier agentic coding model.", isDefault: false, provider: "codex", supportedEfforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" },
  { id: "gpt-5.2",            displayName: "gpt-5.2",            description: "Optimized for professional work and long-running agents.", isDefault: false, provider: "codex", supportedEfforts: ["none", "low", "medium", "high", "xhigh"], defaultEffort: "none" },
  { id: "gpt-5.1-codex-max",  displayName: "gpt-5.1-codex-max",  description: "Codex-optimized model for deep and fast reasoning.", isDefault: false, provider: "codex", supportedEfforts: ["none", "medium", "high", "xhigh"], defaultEffort: "none" },
  { id: "gpt-5.1-codex-mini", displayName: "gpt-5.1-codex-mini", description: "Optimized for codex. Cheaper, faster, but less capable.", isDefault: false, provider: "codex", supportedEfforts: ["medium", "high"], defaultEffort: "medium" },
  { id: "claude-opus-4-7",          displayName: "Claude Opus 4.7",   description: "Most capable model for complex analysis.",          isDefault: false, provider: "claude-code", supportedEfforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
  { id: "claude-opus-4-6",          displayName: "Claude Opus 4.6",   description: "Most capable model for complex analysis.",          isDefault: false, provider: "claude-code", supportedEfforts: ["low", "medium", "high", "max"], defaultEffort: "high" },
  { id: "claude-sonnet-4-6",        displayName: "Claude Sonnet 4.6", description: "Fast, intelligent model for everyday tasks.",       isDefault: true,  provider: "claude-code", supportedEfforts: ["low", "medium", "high", "max"], defaultEffort: "high" },
  { id: "claude-haiku-4-5-20251001", displayName: "Claude Haiku 4.5",  description: "Fastest and most compact model for quick tasks.",   isDefault: false, provider: "claude-code", supportedEfforts: [], defaultEffort: null },
] as const;

export type AvailableModel = (typeof AVAILABLE_MODELS)[number];
