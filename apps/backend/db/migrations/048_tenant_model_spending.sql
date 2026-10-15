-- Keep accounting independent of session retention. Deleting a conversation
-- must not restore the tenant's model allowance.
CREATE TABLE tenant_model_spending_policy (
  tenant_id text PRIMARY KEY REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  monthly_limit_microusd bigint CHECK (monthly_limit_microusd >= 0),
  turn_reservation_microusd bigint NOT NULL CHECK (turn_reservation_microusd > 0),
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE model_spending_reservations (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  reservation_id text NOT NULL,
  period date NOT NULL,
  session_id text NOT NULL,
  user_id text NOT NULL,
  turn_context text NOT NULL CHECK (turn_context IN ('interactive', 'scheduled')),
  reserved_microusd bigint NOT NULL CHECK (reserved_microusd > 0),
  charged_microusd bigint NOT NULL CHECK (charged_microusd >= 0),
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'settled', 'unknown')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, reservation_id)
);
CREATE INDEX model_spending_period ON model_spending_reservations(tenant_id, period);
CREATE TABLE model_spending_calls (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  reservation_id text NOT NULL,
  call_id text NOT NULL,
  model_name text NOT NULL,
  cost_microusd bigint CHECK (cost_microusd >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'complete', 'unknown')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, reservation_id, call_id),
  FOREIGN KEY (tenant_id, reservation_id) REFERENCES model_spending_reservations ON DELETE CASCADE
);
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['tenant_model_spending_policy', 'model_spending_reservations', 'model_spending_calls'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.current_tenant_id'', true)) WITH CHECK (tenant_id = current_setting(''app.current_tenant_id'', true))', name);
  END LOOP;
END $$;
