ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS default_model_id text;
