CREATE TABLE personal_capability_defaults (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  user_id text NOT NULL,
  capability_selection jsonb,
  capability_version integer NOT NULL DEFAULT 0 CHECK (capability_version >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES tenant_memberships (tenant_id, user_id) ON DELETE CASCADE,
  CHECK (
    capability_selection IS NULL OR (
      jsonb_typeof(capability_selection) = 'object'
      AND capability_selection ? 'skillIds'
      AND capability_selection ? 'connectorIds'
      AND jsonb_typeof(capability_selection->'skillIds') = 'array'
      AND jsonb_typeof(capability_selection->'connectorIds') = 'array'
    )
  )
);

ALTER TABLE personal_capability_defaults ENABLE ROW LEVEL SECURITY;
ALTER TABLE personal_capability_defaults FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON personal_capability_defaults
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
