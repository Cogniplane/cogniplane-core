-- Add visualization instructions without changing tenant tool permissions.
INSERT INTO admin_skills (
  tenant_id, skill_id, skill_name, description,
  version, enabled, created_by, active_revision_id
) VALUES (
  'system', 'interactive-ui', 'Interactive UI',
  'Create interactive charts, diagrams, calculators, and tables in chat.',
  1, TRUE, 'system', NULL
)
ON CONFLICT (tenant_id, skill_id) DO NOTHING;

INSERT INTO admin_skill_revisions (
  tenant_id, skill_id, revision_number,
  source_type, source_label,
  bundle_name, bundle_storage_uri, bundle_hash,
  validation_status, validation_messages,
  review_status, review_notes,
  metadata, created_by, reviewed_by, reviewed_at, activated_at
)
SELECT
  'system', 'interactive-ui', 1,
  'seed', 'built-in',
  NULL, NULL, md5('interactive-ui:instructions:v1'),
  'validated', '[]'::jsonb,
  'active', NULL,
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

To request another agent turn, call window.cogniplane.sendMessage(text). This
returns a Promise. The host shows the text and asks the user to confirm before
sending it. Disable the triggering button while the request is pending, handle
an isError result, and allow retry after cancellation. Do not send automatically.
This callback cannot run tools or approve an action.

If the tool fails, use its error to correct the inputs or simplify the widget.
Do not claim the widget works if it did not render. If the user asks for a
downloadable HTML file, also save the file with write_artifact when available.
Artifact previews do not execute scripts.$instructions$
  ),
  'system', 'system', NOW(), NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM admin_skill_revisions
  WHERE tenant_id = 'system' AND skill_id = 'interactive-ui'
);

UPDATE admin_skills
SET active_revision_id = (
  SELECT skill_revision_id
  FROM admin_skill_revisions
  WHERE tenant_id = 'system' AND skill_id = 'interactive-ui'
  ORDER BY revision_number ASC
  LIMIT 1
)
WHERE tenant_id = 'system'
  AND skill_id = 'interactive-ui'
  AND active_revision_id IS NULL;
