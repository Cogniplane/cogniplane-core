-- A Policy Center approval permits one MCP dispatch. The gateway claims it
-- atomically before dispatch; a claimed approval cannot authorize another call.
ALTER TABLE approvals
  ADD COLUMN consumed_at timestamptz;
