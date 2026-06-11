import { z } from "zod";

export const PII_MODES = ["off", "detect", "block", "transform"] as const;
export type PiiMode = (typeof PII_MODES)[number];

export const PII_RAW_RETENTION = ["never", "admin_only", "reversible_encrypted"] as const;
export type PiiRawRetention = (typeof PII_RAW_RETENTION)[number];

export const PII_PROVIDER_TYPES = ["openai-compatible"] as const;
export type PiiProviderType = (typeof PII_PROVIDER_TYPES)[number];

export const PII_ENTITY_TYPES = [
  "email",
  "phone",
  "person_name",
  "address",
  "financial",
  "government_id"
] as const;
export type PiiEntityType = (typeof PII_ENTITY_TYPES)[number];

// Empty string means "use the provider's default model". Any non-empty value
// must be a real provider-recognized model ID — no placeholder sentinel.
const piiProviderSchema = z.object({
  type: z.enum(PII_PROVIDER_TYPES),
  model: z.string().trim().max(256)
});

const piiScopesSchema = z.object({
  chatPrompts: z.boolean(),
  uploads: z.boolean(),
  microsoftImports: z.boolean()
});

const piiActionsSchema = z.object({
  reportToAdmins: z.boolean()
});

const piiDetectorsSchema = z.object({
  useRulesFirst: z.boolean(),
  entityTypes: z.array(z.enum(PII_ENTITY_TYPES)).max(PII_ENTITY_TYPES.length)
});

export const piiProtectionSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(PII_MODES),
  rawRetention: z.enum(PII_RAW_RETENTION),
  provider: piiProviderSchema,
  scopes: piiScopesSchema,
  actions: piiActionsSchema,
  detectors: piiDetectorsSchema
});

export type PiiProtectionSettings = z.infer<typeof piiProtectionSchema>;

export const DEFAULT_PII_PROTECTION: PiiProtectionSettings = {
  enabled: false,
  mode: "off",
  rawRetention: "never",
  provider: {
    type: "openai-compatible",
    // Empty = fall back to PII_LLM_MODEL env var (provider's default).
    model: ""
  },
  scopes: {
    chatPrompts: true,
    uploads: true,
    microsoftImports: true
  },
  actions: {
    reportToAdmins: true
  },
  detectors: {
    useRulesFirst: true,
    entityTypes: [...PII_ENTITY_TYPES]
  }
};

export function parsePiiProtection(value: unknown): PiiProtectionSettings {
  const result = piiProtectionSchema.safeParse(value);
  return result.success ? result.data : DEFAULT_PII_PROTECTION;
}
