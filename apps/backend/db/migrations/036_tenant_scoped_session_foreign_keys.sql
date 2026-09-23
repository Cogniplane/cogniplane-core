-- A globally unique session_id proves that a session exists, but it does not
-- prove that the child row and session belong to the same tenant. Bind both
-- columns so direct store calls cannot create cross-tenant relationships.

ALTER TABLE approvals
  DROP CONSTRAINT approvals_session_id_fkey,
  ADD CONSTRAINT approvals_tenant_session_fkey
    FOREIGN KEY (tenant_id, session_id)
    REFERENCES sessions (tenant_id, session_id)
    ON DELETE CASCADE
    NOT VALID;

ALTER TABLE artifact_download_tokens
  DROP CONSTRAINT artifact_download_tokens_session_id_fkey,
  ADD CONSTRAINT artifact_download_tokens_tenant_session_fkey
    FOREIGN KEY (tenant_id, session_id)
    REFERENCES sessions (tenant_id, session_id)
    ON DELETE CASCADE
    NOT VALID;

ALTER TABLE artifacts
  DROP CONSTRAINT artifacts_session_id_fkey,
  ADD CONSTRAINT artifacts_tenant_session_fkey
    FOREIGN KEY (tenant_id, session_id)
    REFERENCES sessions (tenant_id, session_id)
    ON DELETE CASCADE
    NOT VALID;

-- Audit evidence outlives a deleted session. Null only the session reference,
-- not tenant_id, so the row remains tenant-scoped.
ALTER TABLE audit_events
  DROP CONSTRAINT audit_events_session_id_fkey,
  ADD CONSTRAINT audit_events_tenant_session_fkey
    FOREIGN KEY (tenant_id, session_id)
    REFERENCES sessions (tenant_id, session_id)
    ON DELETE SET NULL (session_id)
    NOT VALID;

ALTER TABLE message_tool_results
  DROP CONSTRAINT message_tool_results_session_id_fkey,
  ADD CONSTRAINT message_tool_results_tenant_session_fkey
    FOREIGN KEY (tenant_id, session_id)
    REFERENCES sessions (tenant_id, session_id)
    ON DELETE CASCADE
    NOT VALID;

ALTER TABLE messages
  DROP CONSTRAINT messages_session_id_fkey,
  ADD CONSTRAINT messages_tenant_session_fkey
    FOREIGN KEY (tenant_id, session_id)
    REFERENCES sessions (tenant_id, session_id)
    NOT VALID;

ALTER TABLE resource_activations
  DROP CONSTRAINT resource_activations_session_id_fkey,
  ADD CONSTRAINT resource_activations_tenant_session_fkey
    FOREIGN KEY (tenant_id, session_id)
    REFERENCES sessions (tenant_id, session_id)
    ON DELETE CASCADE
    NOT VALID;

ALTER TABLE runtime_sessions
  DROP CONSTRAINT runtime_sessions_session_id_fkey,
  ADD CONSTRAINT runtime_sessions_tenant_session_fkey
    FOREIGN KEY (tenant_id, session_id)
    REFERENCES sessions (tenant_id, session_id)
    NOT VALID;

-- Run history remains useful after session retention removes the transcript.
-- Null the session link in that case, while keeping the run's tenant identity.
ALTER TABLE scheduled_job_runs
  ADD CONSTRAINT scheduled_job_runs_tenant_session_fkey
    FOREIGN KEY (tenant_id, session_id)
    REFERENCES sessions (tenant_id, session_id)
    ON DELETE SET NULL (session_id)
    NOT VALID;

ALTER TABLE tool_events
  DROP CONSTRAINT tool_events_session_id_fkey,
  ADD CONSTRAINT tool_events_tenant_session_fkey
    FOREIGN KEY (tenant_id, session_id)
    REFERENCES sessions (tenant_id, session_id)
    ON DELETE CASCADE
    NOT VALID;

ALTER TABLE tool_execution_contexts
  DROP CONSTRAINT tool_execution_contexts_session_id_fkey,
  ADD CONSTRAINT tool_execution_contexts_tenant_session_fkey
    FOREIGN KEY (tenant_id, session_id)
    REFERENCES sessions (tenant_id, session_id)
    ON DELETE CASCADE
    NOT VALID;

ALTER TABLE approvals VALIDATE CONSTRAINT approvals_tenant_session_fkey;
ALTER TABLE artifact_download_tokens VALIDATE CONSTRAINT artifact_download_tokens_tenant_session_fkey;
ALTER TABLE artifacts VALIDATE CONSTRAINT artifacts_tenant_session_fkey;
ALTER TABLE audit_events VALIDATE CONSTRAINT audit_events_tenant_session_fkey;
ALTER TABLE message_tool_results VALIDATE CONSTRAINT message_tool_results_tenant_session_fkey;
ALTER TABLE messages VALIDATE CONSTRAINT messages_tenant_session_fkey;
ALTER TABLE resource_activations VALIDATE CONSTRAINT resource_activations_tenant_session_fkey;
ALTER TABLE runtime_sessions VALIDATE CONSTRAINT runtime_sessions_tenant_session_fkey;
ALTER TABLE scheduled_job_runs VALIDATE CONSTRAINT scheduled_job_runs_tenant_session_fkey;
ALTER TABLE tool_events VALIDATE CONSTRAINT tool_events_tenant_session_fkey;
ALTER TABLE tool_execution_contexts VALIDATE CONSTRAINT tool_execution_contexts_tenant_session_fkey;
