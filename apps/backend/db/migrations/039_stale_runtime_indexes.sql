CREATE INDEX IF NOT EXISTS messages_stale_assistant_idx
  ON messages (updated_at)
  WHERE role = 'assistant' AND status IN ('pending', 'streaming');

CREATE INDEX IF NOT EXISTS runtime_sessions_updated_at_idx
  ON runtime_sessions (tenant_id, updated_at DESC);
