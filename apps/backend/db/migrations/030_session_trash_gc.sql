-- Session retention removes database rows first and records the external
-- cleanup work here. Storage and runtime deletion can then retry after a
-- worker restart or a transient provider failure.
CREATE TABLE session_storage_gc (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  session_id text NOT NULL,
  storage_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT NOW(),
  last_error text,
  PRIMARY KEY (tenant_id, session_id, storage_key)
);
CREATE INDEX session_storage_gc_pending ON session_storage_gc (next_attempt_at, created_at, tenant_id, session_id);

CREATE TABLE session_runtime_gc (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  session_id text NOT NULL,
  user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT NOW(),
  last_error text,
  PRIMARY KEY (tenant_id, session_id)
);
CREATE INDEX session_runtime_gc_pending ON session_runtime_gc (next_attempt_at, created_at, tenant_id, session_id);

ALTER TABLE session_storage_gc ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_storage_gc FORCE ROW LEVEL SECURITY;
CREATE POLICY session_storage_gc_tenant_isolation ON session_storage_gc
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

ALTER TABLE session_runtime_gc ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_runtime_gc FORCE ROW LEVEL SECURITY;
CREATE POLICY session_runtime_gc_tenant_isolation ON session_runtime_gc
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
