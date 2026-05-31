-- 005: Remove the skill-judge (Tier 3) and skill-improvement-session features.
--
-- The LLM session judge and the bespoke skill-improvement launcher were
-- removed from the application. Skill-usage tracking is now handled entirely
-- by Tier 1 telemetry (`resource_activations`, written inline by
-- ActivationTracker), and "improve this skill" is now a normal agent turn
-- driven by the `skill-improver` skill + the `read_skill_corpus` managed tool.
--
-- This migration drops the two now-unused tables, the judge columns on
-- `tenant_settings`, and the orphaned judge-written `resource_activations`
-- rows. DROP TABLE cascades each table's indexes, constraints, and RLS
-- policies. Migrations run as a BYPASSRLS role.

-- Stale Tier-3 telemetry: the judge wrote `materialized` rows with
-- metadata.source = 'llm_judge' to record its invoked/not-invoked verdicts.
-- With the judge gone these only skew corpus ranking, so remove them. Tier-1
-- rows (source tier1_tool_match, or no source) are untouched.
DELETE FROM resource_activations
WHERE event_type = 'materialized'
  AND metadata ->> 'source' = 'llm_judge';

-- Per-tenant judge configuration on the single tenant_settings row.
ALTER TABLE tenant_settings
  DROP CONSTRAINT IF EXISTS tenant_settings_skill_judge_mode_check,
  DROP COLUMN IF EXISTS skill_judge_enabled,
  DROP COLUMN IF EXISTS skill_judge_provider,
  DROP COLUMN IF EXISTS skill_judge_model,
  DROP COLUMN IF EXISTS skill_judge_mode;

-- Judge run/result rows (sync + batch state machine).
DROP TABLE IF EXISTS session_judgments;

-- Link rows for the old skill-improvement launcher flow.
DROP TABLE IF EXISTS skill_improvement_sessions;

-- The built-in skill-improver now drives the agent to call the
-- `read_skill_corpus` managed tool, but tool calls are filtered by
-- `enabled_tool_ids`. Add it to the column default (future fresh tenants)
-- and backfill existing rows that already grant `write_artifact` — the
-- improver's other required tool. Rows that deliberately stripped
-- `write_artifact` are left alone (the improver isn't usable there anyway).
ALTER TABLE tenant_settings
  ALTER COLUMN enabled_tool_ids
  SET DEFAULT '["managed-session-context", "session_context", "list_artifacts", "read_text_artifact", "read_skill_corpus", "write_artifact"]'::jsonb;

UPDATE tenant_settings
SET enabled_tool_ids = enabled_tool_ids || '["read_skill_corpus"]'::jsonb,
    version = version + 1,
    updated_at = NOW()
WHERE enabled_tool_ids @> '["write_artifact"]'::jsonb
  AND NOT (enabled_tool_ids @> '["read_skill_corpus"]'::jsonb);

-- Refresh the built-in skill-improver instructions + tool allowlist to the
-- corpus-tool flow. The pre-005 revision told the agent to read a pre-loaded
-- corpus artifact and only listed `write_artifact`; the new flow has it call
-- `read_skill_corpus` directly. Idempotent: matches the system tenant's
-- active skill-improver revision and rewrites its metadata in place.
UPDATE admin_skill_revisions
SET metadata = jsonb_set(
  jsonb_set(
    metadata,
    '{associatedToolIds}',
    jsonb_build_array('read_skill_corpus', 'write_artifact')
  ),
  '{instructions}',
  to_jsonb($instructions$## Skill Improver

You help the admin improve a single SKILL.md by analyzing how the skill has
actually been used in past sessions.

### Workflow

1. **Read the corpus first.** Call the `read_skill_corpus` tool with the
   target skill's `skillId`. It returns a redacted markdown corpus of recent
   sessions where the skill was offered or used, plus the current SKILL.md.
   Do not propose changes before you have read it. If the corpus is empty or
   very small, say so and ask the admin what they want to focus on instead
   of guessing.

2. **Identify patterns.** Look for:
   - Cases where the skill clearly helped the agent reach a good outcome.
   - Cases where the skill was available but the agent ignored it or
     mis-applied it.
   - User corrections or negative feedback against turns where the skill was
     active.
   - Failed tool calls that the skill should have prevented or handled.
   - Trigger phrasing that appears to mis-fire (skill activated when it
     shouldn't have) or under-fire (skill not activated when it should have).

3. **Propose specific changes** to the SKILL.md, citing evidence from the
   corpus. Each suggestion should reference at least one session id +
   message id from the corpus, e.g. *"In session abc-123, message msg_xyz,
   the agent skipped the artifact step because the trigger only mentioned
   `.py` files — broaden trigger to all generated files."*

4. **Ask the admin clarifying questions** about goals and constraints before
   committing to a final draft. Examples: which audience the skill targets,
   whether to add or remove examples, whether terminology should change.

5. **When the admin approves the direction**, write the final improved
   SKILL.md as an artifact via `write_artifact`. Use the filename
   `SKILL.md`. The admin copies the contents into the inline skill editor,
   which creates a new revision through the normal pipeline.

### Constraints

- Never invent evidence. If the corpus does not support a claim, say so.
- Keep the proposed SKILL.md focused. Removing instructions that no longer
  match observed behavior is as valuable as adding new ones.
- Do not write the artifact until the admin has agreed on the direction.
$instructions$::text)
)
WHERE tenant_id = 'system'
  AND skill_id = 'skill-improver';
