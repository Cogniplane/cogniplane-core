-- Multi-provider LLM support (bead 9p81).
--
-- Adds per-provider encrypted API-key columns to tenant_org_settings so a
-- tenant can configure OpenAI / Google / OpenRouter credentials alongside the
-- existing Anthropic key. Columns are nullable and encrypted at the app layer
-- (lib/crypto-utils) exactly like anthropic_api_key_encrypted.
--
-- No RLS or grant changes are needed: the table's RLS policy is tenant_id
-- based (not column-specific), and migrate.ts reapplies
-- `GRANT ... ON ALL TABLES` after every run, which covers new columns. IF NOT
-- EXISTS keeps this safe to re-apply on a partially-migrated database.

ALTER TABLE public.tenant_org_settings
  ADD COLUMN IF NOT EXISTS openai_api_key_encrypted text;

ALTER TABLE public.tenant_org_settings
  ADD COLUMN IF NOT EXISTS google_api_key_encrypted text;

ALTER TABLE public.tenant_org_settings
  ADD COLUMN IF NOT EXISTS openrouter_api_key_encrypted text;
