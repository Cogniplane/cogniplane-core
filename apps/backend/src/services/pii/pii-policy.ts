import { DEFAULT_PII_PROTECTION, PiiProtectionSettingsSchema } from "@cogniplane/shared-types";
import type { PiiProtectionSettings } from "@cogniplane/shared-types";

export function parsePiiProtection(value: unknown): PiiProtectionSettings {
  const result = PiiProtectionSettingsSchema.safeParse(value);
  return result.success ? result.data : DEFAULT_PII_PROTECTION;
}
