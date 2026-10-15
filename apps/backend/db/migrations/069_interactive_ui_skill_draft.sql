-- The Interactive UI skill (063) tells the model that window.cogniplane.sendMessage
-- asks the user to confirm and then sends the text. The host now puts the text in
-- the message box of the user as an editable draft, and it accepts at most 4,000
-- characters (MCP_APP_MESSAGE_MAX_CHARS in packages/shared-types). Migration 063
-- is applied in existing databases, and migrations are tracked by file name, so
-- this file does not change 063. It adds the new text as a new revision of the
-- skill and makes that revision active. The statements are separate and each one
-- is safe to run again (see "Seed dependent rows with separate statements" in
-- docs/LEARNINGS.md). Tenant tool permissions do not change.
--
-- The revisions are found by what they are, not by their number. An operator can
-- have added revisions to the system skill. So:
--   * The new text is added at the next free revision number, once. The hash
--     md5('interactive-ui:instructions:v2') marks it.
--   * The new revision becomes active only if the active revision is still the
--     seed of migration 063: source type 'seed', the hash
--     md5('interactive-ui:instructions:v1'), and the text of 063 (the md5 below
--     is the md5 of that text). If an operator activated another revision, or
--     changed the seed, the new revision is added as 'approved' and nothing else
--     changes.
--   * No other revision is changed. Only the 063 seed (to 'approved') and the new
--     revision (to 'active') change their review status.

INSERT INTO admin_skill_revisions (
  tenant_id, skill_id, revision_number,
  source_type, source_label,
  bundle_name, bundle_storage_uri, bundle_hash,
  validation_status, validation_messages,
  review_status, review_notes,
  metadata, created_by, reviewed_by, reviewed_at, activated_at
)
SELECT
  'system', 'interactive-ui',
  (SELECT COALESCE(MAX(revision_number), 0) + 1 FROM admin_skill_revisions
    WHERE tenant_id = 'system' AND skill_id = 'interactive-ui'),
  'seed', 'built-in',
  NULL, NULL, md5('interactive-ui:instructions:v2'),
  'validated', '[]'::jsonb,
  'approved', NULL,
  jsonb_build_object(
    'skillName', 'Interactive UI',
    'description', 'Create interactive charts, diagrams, calculators, and tables in chat.',
    'associatedToolIds', jsonb_build_array('render_interactive_ui'),
    'instructions', $instructions$# Interactive UI

Use render_interactive_ui when an interactive view helps answer the user.
Use plain text for short factual answers. Call the tool only when it is available.

## Choose a useful view

- Use a chart to compare values or show trends.
- Use an SVG diagram to explain relationships or a process.
- Use a calculator to explore assumptions.
- Use a table with filters to explore records.

Read source files and company data through authorized tools first. Use the real
values and name the sources in the summary. Label estimates and sample data.
Include the key finding in your text response so the answer remains useful if
the interactive view cannot load. Do not let the widget invent data or fetch it.

## Create the widget

Call render_interactive_ui with title, description, and html. The description is
a plain-text summary of the result. Supply an HTML fragment with inline CSS and
JavaScript. Aim for fewer than 20,000 characters and never exceed 64,000.

The host adds a heading, summary, and theme styles. Use the CSS variables
--background, --foreground, --muted, --border, and --primary. Build responsive
layouts with labeled inputs, keyboard controls, and readable contrast. Use
inline SVG or canvas for charts. Handle empty data and invalid inputs. Use
DOMContentLoaded for initialization if the code needs the completed document.

The widget runs in an isolated iframe. It cannot access the application,
credentials, cookies, browser storage, or the network. Do not use external
scripts, fonts, images, frames, fetch, eval, new Function, browser dialogs,
or form submission. All calculations and controls must work locally.

To suggest a follow-up message, call window.cogniplane.sendMessage(text). This
returns a Promise. The host does not send the text. It puts the text in the
message box of the user as an editable draft, with a notice that names this
tool. The user reads the draft, changes it if needed, and presses Send. Write
plain text of at most 4,000 characters. Do not add blank lines, hidden control
characters, or text direction characters. The host warns the user about them.
Longer text returns an isError result, and so does a request while the chat is
busy or read-only. If the user already has a draft, the host asks the user first,
and the Promise returns an isError result when the user declines. The Promise
resolves with an empty result when the draft is in the message box, and it never
says whether the user sent it. Disable the triggering button while the request is
pending, handle an isError result, and allow retry. Do not tell the user that a
message was sent. This callback cannot run tools or approve an action.

If the tool fails, use its error to correct the inputs or simplify the widget.
Do not claim the widget works if it did not render. If the user asks for a
downloadable HTML file, also save the file with write_artifact when available.
Artifact previews do not execute scripts.$instructions$
  ),
  'system', 'system', NOW(), NULL::timestamptz
FROM admin_skills skill
WHERE skill.tenant_id = 'system'
  AND skill.skill_id = 'interactive-ui'
  AND NOT EXISTS (
    SELECT 1 FROM admin_skill_revisions
    WHERE tenant_id = 'system' AND skill_id = 'interactive-ui'
      AND bundle_hash = md5('interactive-ui:instructions:v2')
  );

WITH seed AS (
  SELECT skill_revision_id FROM admin_skill_revisions
  WHERE tenant_id = 'system' AND skill_id = 'interactive-ui'
    AND source_type = 'seed'
    AND bundle_hash = md5('interactive-ui:instructions:v1')
    AND md5(metadata ->> 'instructions') = '9160e17a2041bdef6edb4bd9ab67ea22'
), draft AS (
  SELECT skill_revision_id FROM admin_skill_revisions
  WHERE tenant_id = 'system' AND skill_id = 'interactive-ui'
    AND source_type = 'seed'
    AND bundle_hash = md5('interactive-ui:instructions:v2')
)
-- Mark the new revision active and the 063 seed approved, as the activation of a
-- revision does. Only while the 063 seed is still the active revision.
UPDATE admin_skill_revisions revision
SET review_status = CASE WHEN revision.skill_revision_id = draft.skill_revision_id THEN 'active' ELSE 'approved' END,
    activated_at = CASE WHEN revision.skill_revision_id = draft.skill_revision_id THEN NOW() ELSE revision.activated_at END
FROM admin_skills skill, seed, draft
WHERE skill.tenant_id = 'system'
  AND skill.skill_id = 'interactive-ui'
  AND skill.active_revision_id = seed.skill_revision_id
  AND revision.skill_revision_id IN (seed.skill_revision_id, draft.skill_revision_id);

WITH seed AS (
  SELECT skill_revision_id FROM admin_skill_revisions
  WHERE tenant_id = 'system' AND skill_id = 'interactive-ui'
    AND source_type = 'seed'
    AND bundle_hash = md5('interactive-ui:instructions:v1')
    AND md5(metadata ->> 'instructions') = '9160e17a2041bdef6edb4bd9ab67ea22'
), draft AS (
  SELECT skill_revision_id FROM admin_skill_revisions
  WHERE tenant_id = 'system' AND skill_id = 'interactive-ui'
    AND source_type = 'seed'
    AND bundle_hash = md5('interactive-ui:instructions:v2')
)
-- Point the skill at the new revision. The version rises, as for any activation.
UPDATE admin_skills skill
SET active_revision_id = draft.skill_revision_id,
    version = skill.version + 1,
    updated_at = NOW()
FROM seed, draft
WHERE skill.tenant_id = 'system'
  AND skill.skill_id = 'interactive-ui'
  AND skill.active_revision_id = seed.skill_revision_id;
