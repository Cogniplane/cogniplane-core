-- Backfill `tenant_org_settings` on databases that ran an earlier copy of
-- 001_init.sql which predated this table. The table is defined in 001_init.sql
-- for fresh databases; this migration is a no-op on those (CREATE TABLE IF NOT
-- EXISTS + idempotent ALTER guards) and forward-fills any DB initialized before
-- the table was squashed into the init file.
--
-- The 500 we saw in demo logs (`relation "tenant_org_settings" does not exist`
-- when GET /models calls hasOpenaiApiKey / hasAnthropicApiKey) was caused
-- exactly by this drift: `schema_migrations` had `001_init.sql` recorded against
-- the older init body, so the new table never landed.

CREATE TABLE IF NOT EXISTS public.tenant_org_settings (
    tenant_id text NOT NULL,
    openai_api_key_encrypted text,
    anthropic_api_key_encrypted text,
    skill_marketplace_manifest_url text,
    pii_protection jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_org_settings_pkey PRIMARY KEY (tenant_id)
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'tenant_org_settings_tenant_id_fkey'
    ) THEN
        ALTER TABLE public.tenant_org_settings
            ADD CONSTRAINT tenant_org_settings_tenant_id_fkey
            FOREIGN KEY (tenant_id) REFERENCES public.tenants(tenant_id) ON DELETE CASCADE;
    END IF;
END
$$;

ALTER TABLE public.tenant_org_settings ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'tenant_org_settings'
          AND policyname = 'tenant_org_settings_tenant_isolation'
    ) THEN
        CREATE POLICY tenant_org_settings_tenant_isolation
            ON public.tenant_org_settings
            USING ((tenant_id = current_setting('app.current_tenant_id'::text, true)))
            WITH CHECK ((tenant_id = current_setting('app.current_tenant_id'::text, true)));
    END IF;
END
$$;
