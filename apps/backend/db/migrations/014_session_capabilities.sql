ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS capability_selection jsonb,
  ADD COLUMN IF NOT EXISTS capability_version integer NOT NULL DEFAULT 0;

-- NULL inherits current organization defaults. Empty arrays select nothing.
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_capability_selection_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_capability_selection_check CHECK (
  capability_selection IS NULL OR (
    jsonb_typeof(capability_selection) = 'object'
    AND capability_selection ? 'skillIds'
    AND capability_selection ? 'connectorIds'
    AND jsonb_typeof(capability_selection->'skillIds') = 'array'
    AND jsonb_typeof(capability_selection->'connectorIds') = 'array'
  )
);
