-- Add `web_search_mode` to tenant_settings so admins can enable Codex's native
-- web search per tenant. Codex's config exposes a top-level `web_search`
-- (WebSearchMode = disabled | cached | live); the runtime workspace writes the
-- chosen mode into the generated codex.toml. The Claude runtime already exposes
-- WebSearch via the SDK's `claude_code` tool preset, so this column only governs
-- the Codex path.
--
-- Idempotent: `ADD COLUMN IF NOT EXISTS` is a no-op on fresh databases where
-- 001_init.sql already created the column. Default 'disabled' is safe for every
-- existing tenant — web search stays off until explicitly enabled.

ALTER TABLE public.tenant_settings
    ADD COLUMN IF NOT EXISTS web_search_mode text DEFAULT 'disabled'::text NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'tenant_settings_web_search_mode_check'
    ) THEN
        ALTER TABLE public.tenant_settings
            ADD CONSTRAINT tenant_settings_web_search_mode_check
            CHECK ((web_search_mode = ANY (ARRAY['disabled'::text, 'cached'::text, 'live'::text])));
    END IF;
END
$$;
