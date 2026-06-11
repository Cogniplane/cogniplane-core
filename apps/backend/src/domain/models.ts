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
  // Max input context in tokens, used by the composer's context-window meter.
  // Codex GPT-5.x models run through `codex app-server`, which caps context at
  // the documented Codex window (400K) regardless of the larger raw-API limit —
  // so 400K is the honest gauge denominator here. Claude Opus 4.6/4.7/4.8 and
  // Sonnet 4.6 are 1M on the Claude API (what the Agent SDK uses by default);
  // Haiku 4.5 is 200K. Revisit if a 1M Codex override or a new model ships.
  contextWindow: number;
}[] = [
  { id: "gpt-5.5",             displayName: "gpt-5.5",             description: "Latest frontier agentic coding model.", isDefault: false, provider: "codex", supportedEfforts: ["none", "low", "medium", "high", "xhigh"], defaultEffort: "none", contextWindow: 400_000 },
  { id: "gpt-5.4",            displayName: "gpt-5.4",            description: "Latest frontier agentic coding model.", isDefault: false, provider: "codex", supportedEfforts: ["none", "low", "medium", "high", "xhigh"], defaultEffort: "none", contextWindow: 400_000 },
  { id: "gpt-5.4-mini",       displayName: "gpt-5.4-mini",       description: "Smaller frontier agentic coding model.", isDefault: true,  provider: "codex", supportedEfforts: ["none", "low", "medium", "high", "xhigh"], defaultEffort: "none", contextWindow: 400_000 },
  { id: "gpt-5.3-codex",      displayName: "gpt-5.3-codex",      description: "Frontier Codex-optimized agentic coding model.", isDefault: false, provider: "codex", supportedEfforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium", contextWindow: 400_000 },
  { id: "gpt-5.2-codex",      displayName: "gpt-5.2-codex",      description: "Frontier agentic coding model.", isDefault: false, provider: "codex", supportedEfforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium", contextWindow: 400_000 },
  { id: "gpt-5.2",            displayName: "gpt-5.2",            description: "Optimized for professional work and long-running agents.", isDefault: false, provider: "codex", supportedEfforts: ["none", "low", "medium", "high", "xhigh"], defaultEffort: "none", contextWindow: 400_000 },
  { id: "gpt-5.1-codex-max",  displayName: "gpt-5.1-codex-max",  description: "Codex-optimized model for deep and fast reasoning.", isDefault: false, provider: "codex", supportedEfforts: ["none", "medium", "high", "xhigh"], defaultEffort: "none", contextWindow: 400_000 },
  { id: "gpt-5.1-codex-mini", displayName: "gpt-5.1-codex-mini", description: "Optimized for codex. Cheaper, faster, but less capable.", isDefault: false, provider: "codex", supportedEfforts: ["medium", "high"], defaultEffort: "medium", contextWindow: 400_000 },
  { id: "claude-opus-4-8",          displayName: "Claude Opus 4.8",   description: "Most capable model for complex analysis.",          isDefault: true,  provider: "claude-code", supportedEfforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high", contextWindow: 1_000_000 },
  { id: "claude-opus-4-7",          displayName: "Claude Opus 4.7",   description: "Most capable model for complex analysis.",          isDefault: false, provider: "claude-code", supportedEfforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high", contextWindow: 1_000_000 },
  { id: "claude-opus-4-6",          displayName: "Claude Opus 4.6",   description: "Most capable model for complex analysis.",          isDefault: false, provider: "claude-code", supportedEfforts: ["low", "medium", "high", "max"], defaultEffort: "high", contextWindow: 1_000_000 },
  { id: "claude-sonnet-4-6",        displayName: "Claude Sonnet 4.6", description: "Fast, intelligent model for everyday tasks.",       isDefault: false, provider: "claude-code", supportedEfforts: ["low", "medium", "high", "max"], defaultEffort: "high", contextWindow: 1_000_000 },
  { id: "claude-haiku-4-5-20251001", displayName: "Claude Haiku 4.5",  description: "Fastest and most compact model for quick tasks.",   isDefault: false, provider: "claude-code", supportedEfforts: [], defaultEffort: null, contextWindow: 200_000 },
] as const;

export type AvailableModel = (typeof AVAILABLE_MODELS)[number];
