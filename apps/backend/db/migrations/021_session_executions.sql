ALTER TABLE sessions ADD CONSTRAINT sessions_tenant_session_key UNIQUE (tenant_id, session_id);
CREATE TABLE session_executions (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id),
  session_id text NOT NULL,
  execution_id text NOT NULL UNIQUE,
  user_id text NOT NULL REFERENCES users(user_id),
  project_id text,
  runtime_id text,
  status text NOT NULL CHECK (status IN ('active', 'stopped', 'finished')),
  stop_reason text,
  expires_at timestamptz NOT NULL,
  started_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, session_id),
  FOREIGN KEY (tenant_id, session_id) REFERENCES sessions(tenant_id, session_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, project_id)
);
ALTER TABLE session_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_executions FORCE ROW LEVEL SECURITY;
CREATE POLICY session_executions_tenant_isolation ON session_executions
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
CREATE INDEX session_executions_project ON session_executions(tenant_id, project_id)
  WHERE status = 'active';

-- Revocation is durable even if access is restored before a worker polls.
-- These functions run with the caller's privileges and tenant scope.
CREATE FUNCTION fence_project_executions(target_tenant text, target_project text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE session_executions e SET status='stopped', stop_reason='permission_changed', updated_at=NOW()
  WHERE e.tenant_id=target_tenant AND e.project_id=target_project AND e.status='active'
    AND NOT EXISTS (
      SELECT 1 FROM projects p JOIN tenant_memberships tm ON tm.tenant_id=p.tenant_id AND tm.user_id=e.user_id
      LEFT JOIN project_memberships pm ON pm.tenant_id=p.tenant_id AND pm.project_id=p.project_id AND pm.user_id=e.user_id
      WHERE p.tenant_id=e.tenant_id AND p.project_id=e.project_id AND p.archived_at IS NULL
        AND (pm.role IN ('owner','editor') OR (p.visibility='organization' AND p.organization_role='editor'))
    );
END;
$$;

CREATE FUNCTION fence_changed_project_executions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM fence_project_executions(OLD.tenant_id, OLD.project_id);
  RETURN NULL;
END;
$$;
CREATE TRIGGER project_membership_execution_revocation AFTER UPDATE OR DELETE ON project_memberships
  FOR EACH ROW EXECUTE FUNCTION fence_changed_project_executions();
CREATE TRIGGER project_sharing_execution_revocation AFTER UPDATE OF visibility, organization_role, archived_at ON projects
  FOR EACH ROW EXECUTE FUNCTION fence_changed_project_executions();

CREATE FUNCTION fence_departed_member_executions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE session_executions SET status='stopped', stop_reason='permission_changed', updated_at=NOW()
    WHERE tenant_id=OLD.tenant_id AND user_id=OLD.user_id AND status='active';
  RETURN NULL;
END;
$$;
CREATE TRIGGER organization_membership_execution_revocation AFTER DELETE ON tenant_memberships
  FOR EACH ROW EXECUTE FUNCTION fence_departed_member_executions();

CREATE FUNCTION fence_changed_session_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'active' OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    UPDATE session_executions SET status='stopped', stop_reason='session_changed', updated_at=NOW()
      WHERE tenant_id=OLD.tenant_id AND session_id=OLD.session_id AND status='active';
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER session_execution_revocation AFTER UPDATE OF status, project_id ON sessions
  FOR EACH ROW EXECUTE FUNCTION fence_changed_session_execution();

CREATE FUNCTION expire_stopped_execution_approvals() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'active' THEN
    UPDATE approvals SET status='expired', resolved_at=NOW(), updated_at=NOW()
      WHERE tenant_id=OLD.tenant_id AND session_id=OLD.session_id
        AND runtime_id=OLD.runtime_id AND status='pending';
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER stopped_execution_approvals AFTER UPDATE OF status ON session_executions
  FOR EACH ROW EXECUTE FUNCTION expire_stopped_execution_approvals();
