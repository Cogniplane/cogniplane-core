-- System-tenant defaults seeded after the schema in 001_init.sql.
--
-- Idempotent — uses ON CONFLICT DO NOTHING and the three-statement
-- skill-seed pattern documented in CLAUDE.md ("Idempotent seed SQL pattern").
-- Re-runs harmlessly so a fresh DB after a partial migrate produces the same
-- terminal state.

-- ─── Tenants ──────────────────────────────────────────────────────────────

INSERT INTO tenants (tenant_id, tenant_name, slug) VALUES
  ('local-dev-tenant', 'Local Development', 'local-dev'),
  ('system',           'System Defaults',   'system')
ON CONFLICT (tenant_id) DO NOTHING;

-- ─── Built-in MCP servers (system tenant) ─────────────────────────────────

INSERT INTO admin_mcp_servers (
  tenant_id, server_id, server_name, description,
  transport_kind, mode, route_path, upstream_url, headers_allowlist,
  version, config_hash, enabled, created_by
) VALUES
  (
    'system', 'managed-session-context', 'Managed session context',
    'Read current session context and recent message history through first-party managed tools.',
    'http', 'managed', '/mcp/managed-session-context', NULL, '[]'::jsonb,
    1, md5('managed-session-context:v1'), TRUE, 'system'
  ),
  -- Disabled by default. Trusted-echo is a placeholder proxy server kept here
  -- as a worked example for tenants that want to wire their own upstream MCP.
  (
    'system', 'trusted-echo', 'Trusted echo',
    'Forward validated framework context to a trusted upstream MCP server.',
    'http', 'proxy', '/mcp/trusted-echo', NULL,
    '["X-Framework-User-Id","X-Framework-Session-Id","X-Framework-Runtime-Id"]'::jsonb,
    1, md5('trusted-echo:v1'), FALSE, 'system'
  )
ON CONFLICT (tenant_id, server_id) DO NOTHING;

-- ─── Built-in skill: write-artifact ───────────────────────────────────────
-- Tells the agent to call write_artifact for every deliverable file so the
-- file shows up in the session Artifacts panel.

INSERT INTO admin_skills (
  tenant_id, skill_id, skill_name, description,
  version, enabled, created_by, active_revision_id
) VALUES (
  'system', 'write-artifact', 'Write Artifact',
  'Instructs the agent to save generated files via the write_artifact tool.',
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
  'system', 'write-artifact', 1,
  'seed', 'built-in',
  NULL, NULL, md5('write-artifact:instructions:v3'),
  'validated', '[]'::jsonb,
  'active', NULL,
  jsonb_build_object(
    'skillName', 'Write Artifact',
    'description', 'Instructs the agent to save generated files via the write_artifact tool.',
    'instructions', $instructions$## Artifacts vs. scratch files

Use the filesystem (Write tool, shell redirects, etc.) normally for anything you
need for your own work: scripts you are about to execute, intermediate data,
tests, temp files. Those do NOT need to become artifacts.

**Artifacts are for the user.** Any file the user is expected to see, download,
or reuse is a deliverable and MUST also be saved as an artifact by calling the
write_artifact tool — in addition to writing it to disk.

### When to call write_artifact

Call it for every file that represents a deliverable, including but not
limited to:

- The final script the user asked for (e.g. `fibonacci.py`)
- Generated documents (HTML pages, Markdown reports, CSV/TSV data exports)
- Images, PDFs, or other binary outputs the user should download
- Any file you tell the user is "ready", "saved", or "available"

Skip it for:

- Scratch files only you will read (/tmp/*, hidden working files)
- Test files and fixtures the user did not ask for
- Build artifacts produced as a side effect of running a task

If you are unsure whether a file is a deliverable, save it as an artifact.

### Tool name by runtime

- **Claude Code runtime**: the tool is exposed as
  `mcp__managed-session-context__write_artifact`. Call it by that fully
  qualified name.
- **Codex runtime**: call it as `write_artifact`.

### Parameters

- `toolContextId` — the current tool context ID (always required)
- `name` — filename with extension (e.g. `fibonacci.py`, `report.html`)
- `content` — the full file content as a string, OR
- `filePath` — a workspace path; the server reads the file directly (best for
  binary or large outputs — do NOT also pass `content`)
- `mimeType` (optional) — inferred from the extension when omitted

### Typical flow

1. Write the file to the workspace filesystem so you can run, test, or iterate.
2. Execute it if the user asked you to.
3. Call write_artifact with the filename and content for every deliverable
   the user should see.
4. Tell the user the file is available in the Artifacts panel.

Save the artifact BEFORE confirming to the user. If write_artifact fails,
report the error and show the content inline.$instructions$
  ),
  'system', 'system', NOW(), NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM admin_skill_revisions
  WHERE tenant_id = 'system' AND skill_id = 'write-artifact'
);

UPDATE admin_skills
SET active_revision_id = (
  SELECT skill_revision_id
  FROM admin_skill_revisions
  WHERE tenant_id = 'system' AND skill_id = 'write-artifact'
  ORDER BY revision_number ASC
  LIMIT 1
)
WHERE tenant_id = 'system'
  AND skill_id = 'write-artifact'
  AND active_revision_id IS NULL;

-- ─── Built-in skill: skill-improver ───────────────────────────────────────
-- Drives improver sessions launched from the admin skills page. Per-session
-- runtime overrides narrow the active skill list to just this one + the
-- corpus artifact when the admin starts a session.

INSERT INTO admin_skills (
  tenant_id, skill_id, skill_name, description,
  version, enabled, created_by, active_revision_id
) VALUES (
  'system', 'skill-improver', 'Skill Improver',
  'Analyzes a corpus of past sessions where a skill was used and proposes a revised SKILL.md.',
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
  'system', 'skill-improver', 1,
  'seed', 'built-in',
  NULL, NULL, md5('skill-improver:instructions:v1'),
  'validated', '[]'::jsonb,
  'active', NULL,
  jsonb_build_object(
    'skillName', 'Skill Improver',
    'description', 'Analyzes a corpus of past sessions where a skill was used and proposes a revised SKILL.md.',
    'associatedToolIds', jsonb_build_array('write_artifact'),
    'instructions', $instructions$## Skill Improver

You help the admin improve a single SKILL.md by analyzing how the skill has
actually been used in past sessions. The session has been pre-loaded with one
markdown artifact named `skill-improvement-corpus-<skill>-<timestamp>.md`
that contains redacted excerpts from real sessions where the skill was
invoked, plus the current SKILL.md content.

### Workflow

1. **Read the corpus artifact first.** Use `read_text_artifact` to load it.
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
   `SKILL.md`. The admin will copy the contents into the inline skill
   editor, which creates a new revision through the normal pipeline.

### Constraints

- This session is restricted to read-only corpus tools and `write_artifact`.
  You cannot run shell commands, fetch URLs, or call other MCP servers.
- Never invent evidence. If the corpus does not support a claim, say so.
- Keep the proposed SKILL.md focused. Removing instructions that no longer
  match observed behavior is as valuable as adding new ones.
- Do not write the artifact until the admin has agreed on the direction.
$instructions$
  ),
  'system', 'system', NOW(), NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM admin_skill_revisions
  WHERE tenant_id = 'system' AND skill_id = 'skill-improver'
);

UPDATE admin_skills
SET active_revision_id = (
  SELECT skill_revision_id
  FROM admin_skill_revisions
  WHERE tenant_id = 'system' AND skill_id = 'skill-improver'
  ORDER BY revision_number ASC
  LIMIT 1
)
WHERE tenant_id = 'system'
  AND skill_id = 'skill-improver'
  AND active_revision_id IS NULL;
