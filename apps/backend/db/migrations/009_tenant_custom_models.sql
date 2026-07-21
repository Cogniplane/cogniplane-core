-- Admin-managed custom models (bead: custom models, OpenRouter-first).
--
-- Per-tenant additions to the built-in model catalog. model_id is the full
-- namespaced id "<provider>/<vendorModelId>" (e.g.
-- "openrouter/moonshotai/kimi-k3") — the namespace doubles as the provider so
-- the Deep Agents graph can construct the model without a DB lookup.
-- Custom models always run with supportedEfforts=[] (no reasoning-effort
-- wiring), so no effort columns exist here.

CREATE TABLE public.tenant_custom_models (
  tenant_id text NOT NULL,
  model_id text NOT NULL,
  provider text NOT NULL,
  vendor_model_id text NOT NULL,
  display_name text NOT NULL,
  description text NOT NULL DEFAULT '',
  context_window integer NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, model_id)
);

ALTER TABLE public.tenant_custom_models ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_custom_models_tenant_read ON public.tenant_custom_models
  FOR SELECT USING (tenant_id = current_setting('app.current_tenant_id'::text, true));
CREATE POLICY tenant_custom_models_tenant_insert ON public.tenant_custom_models
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.current_tenant_id'::text, true));
CREATE POLICY tenant_custom_models_tenant_update ON public.tenant_custom_models
  FOR UPDATE USING (tenant_id = current_setting('app.current_tenant_id'::text, true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id'::text, true));
CREATE POLICY tenant_custom_models_tenant_delete ON public.tenant_custom_models
  FOR DELETE USING (tenant_id = current_setting('app.current_tenant_id'::text, true));
