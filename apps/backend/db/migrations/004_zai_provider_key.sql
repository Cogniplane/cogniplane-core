-- Z.AI (Zhipu / GLM) direct provider support (AgenticEntrepriseFramework-i52g).
--
-- Adds a per-tenant encrypted API-key column for the Z.AI provider, mirroring
-- the OpenAI / Google / OpenRouter columns from 003. Nullable and encrypted at
-- the app layer (lib/crypto-utils) exactly like the other provider keys. Z.AI
-- reaches its OpenAI-compatible API (base URL in MODEL_PROVIDER_META);
-- see MODEL_PROVIDER_META in @cogniplane/shared-types.
--
-- No RLS or grant changes needed: the table's RLS policy is tenant_id based
-- (not column-specific), and migrate.ts reapplies `GRANT ... ON ALL TABLES`
-- after every run. IF NOT EXISTS keeps this safe to re-apply.

ALTER TABLE public.tenant_org_settings
  ADD COLUMN IF NOT EXISTS zai_api_key_encrypted text;
