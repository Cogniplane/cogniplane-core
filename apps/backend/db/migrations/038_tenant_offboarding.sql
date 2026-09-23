-- Tenant offboarding has one database root: deleting a tenant must remove every
-- row with that tenant_id. Existing foreign keys were RESTRICT by default and
-- several child tables only reached tenants through another parent. Make the
-- root cascade explicit, then guard the invariant in integration tests.
DO $$
DECLARE
  relation record;
  existing_constraint_name text;
  constraint_name text;
BEGIN
  FOR relation IN
    SELECT c.table_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.column_name = 'tenant_id'
      AND c.table_name <> 'tenants'
    ORDER BY c.table_name
  LOOP
    existing_constraint_name := NULL;

    SELECT con.conname INTO existing_constraint_name
    FROM pg_constraint con
    JOIN pg_attribute child_column
      ON child_column.attrelid = con.conrelid
     AND child_column.attnum = con.conkey[1]
    WHERE con.contype = 'f'
      AND con.conrelid = format('public.%I', relation.table_name)::regclass
      AND con.confrelid = 'public.tenants'::regclass
      AND array_length(con.conkey, 1) = 1
      AND child_column.attname = 'tenant_id'
    LIMIT 1;

    IF existing_constraint_name IS NOT NULL THEN
      constraint_name := existing_constraint_name;
      EXECUTE format(
        'ALTER TABLE public.%I DROP CONSTRAINT %I',
        relation.table_name,
        constraint_name
      );
    ELSE
      constraint_name := left(relation.table_name || '_tenant_offboarding_fkey', 63);
    END IF;

    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) REFERENCES public.tenants(tenant_id) ON DELETE CASCADE',
      relation.table_name,
      constraint_name
    );
  END LOOP;
END $$;

-- The receipt deliberately has no tenant_id column or FK. It outlives the
-- deleted tenant and stores only a one-way identifier hash, aggregate counts,
-- operator dispositions, and timestamps. It contains no customer content.
CREATE TABLE tenant_deletion_receipts (
  request_id text PRIMARY KEY,
  tenant_id_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('cleanup_pending', 'cleanup_failed', 'completed')),
  row_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  object_count integer NOT NULL DEFAULT 0 CHECK (object_count >= 0),
  runtime_thread_count integer NOT NULL DEFAULT 0 CHECK (runtime_thread_count >= 0),
  deleted_object_count integer NOT NULL DEFAULT 0 CHECK (deleted_object_count >= 0),
  retained_shared_object_count integer NOT NULL DEFAULT 0 CHECK (retained_shared_object_count >= 0),
  purged_runtime_thread_count integer NOT NULL DEFAULT 0 CHECK (purged_runtime_thread_count >= 0),
  redis_disposition text NOT NULL,
  third_party_disposition text NOT NULL,
  backup_disposition text NOT NULL,
  initiated_at timestamptz NOT NULL DEFAULT NOW(),
  database_deleted_at timestamptz NOT NULL,
  completed_at timestamptz,
  last_error text
);

CREATE INDEX tenant_deletion_receipts_tenant_hash
  ON tenant_deletion_receipts (tenant_id_hash);

CREATE TABLE tenant_deletion_cleanup (
  request_id text NOT NULL REFERENCES tenant_deletion_receipts(request_id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('artifact', 'skill_bundle', 'runtime_thread', 'redis_database')),
  locator text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (request_id, kind, locator)
);

-- These are operator-only tables. The application role receives broad table
-- grants during migration setup, so FORCE RLS with no policies keeps request
-- traffic out while the privileged offboarding command retains access.
ALTER TABLE tenant_deletion_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_deletion_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_deletion_cleanup ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_deletion_cleanup FORCE ROW LEVEL SECURITY;
