-- Bring tenant_custom_models up to the RLS posture of every other tenant table.
--
-- Migration 009 created the table with ENABLE ROW LEVEL SECURITY and four
-- policies, but omitted FORCE and the tenant foreign key that the 31 tenant
-- tables in 001_init.sql both carry.
--
-- What FORCE changes: ENABLE alone exempts the table OWNER from its own
-- policies. Migrations run as superuser and superusers bypass RLS either way,
-- so this is not a behaviour change for the migration runner — it closes the
-- case where the owning role is not a superuser. CustomModelStore runs on the
-- RLS-scoped app pool and every method goes through withTenantScope, so no
-- runtime path relies on the owner exemption.

-- The FK cannot be added while rows point at tenants that do not exist. Such
-- rows are only reachable in dev-headers mode, where any X-Tenant-Id header is
-- accepted but only 'local-dev-tenant' is seeded. They are junk either way: a
-- custom model for a tenant that was never created can never be resolved.
DELETE FROM public.tenant_custom_models c
  WHERE NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.tenant_id = c.tenant_id);

ALTER TABLE public.tenant_custom_models FORCE ROW LEVEL SECURITY;

-- No ON DELETE clause, matching the 001_init.sql pattern; nothing deletes
-- tenants.
ALTER TABLE public.tenant_custom_models
  ADD CONSTRAINT tenant_custom_models_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES public.tenants(tenant_id);
