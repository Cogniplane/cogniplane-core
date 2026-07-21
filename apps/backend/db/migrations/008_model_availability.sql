-- Model availability controls on tenant_settings (bead icx0).
--
-- enabled_providers: explicit per-tenant provider allowlist. Defaults to every
--   provider so existing tenants keep today's inferred behavior (any provider
--   with a key is usable) until an admin deliberately disables one.
-- enabled_model_ids: NULL means "all catalog models" (new models appear
--   without an admin action); a JSON array is a strict allowlist.
-- model_default_efforts: per-model default reasoning effort overriding the
--   catalog default ({"<modelId>": "<effort>"}).

ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS enabled_providers jsonb NOT NULL
    DEFAULT '["anthropic","openai","google","openrouter","zai"]'::jsonb,
  ADD COLUMN IF NOT EXISTS enabled_model_ids jsonb,
  ADD COLUMN IF NOT EXISTS model_default_efforts jsonb NOT NULL
    DEFAULT '{}'::jsonb;
