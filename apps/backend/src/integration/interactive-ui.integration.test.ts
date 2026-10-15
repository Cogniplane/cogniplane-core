import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";

import { SkillConfigStore } from "../services/skills/skill-config-store.js";
import { MessageStore, type UpsertToolResultInput } from "../services/message-store.js";
import { createInteractiveUiTool, INTERACTIVE_UI_RESOURCE_URI } from "../services/managed-tools/interactive-ui.js";
import { adminDatabaseUrl, appPool, superuserPool } from "./support/database.js";
import { seedTenantGraph } from "./support/fixtures.js";

const SYSTEM_SKILL = "tenant_id='system' AND skill_id='interactive-ui'";
const md5 = (text: string) => createHash("md5").update(text, "utf8").digest("hex");
const SEED_HASH = md5("interactive-ui:instructions:v1");
const DRAFT_HASH = md5("interactive-ui:instructions:v2");
const OPERATOR_TEXT = "Operator text";

type RevisionRow = { revision_number: number; review_status: string; bundle_hash: string; instructions: string; tool_ids: unknown };

const migration = (file: string) => readFile(new URL(`../../db/migrations/${file}`, import.meta.url), "utf8");
const applyMigration = async (file: string) => { await superuserPool().query(await migration(file)); };
const revisions = async () => (await superuserPool().query(
  `SELECT revision_number::int AS revision_number, review_status, bundle_hash, metadata ->> 'instructions' AS instructions,
          metadata -> 'associatedToolIds' AS tool_ids
   FROM admin_skill_revisions WHERE ${SYSTEM_SKILL} ORDER BY revision_number`)).rows as RevisionRow[];
const summary = (rows: RevisionRow[]) => rows.map((row) => [row.revision_number, row.review_status, row.bundle_hash]);
const skillRow = async () => (await superuserPool().query(
  `SELECT version, active_revision_id FROM admin_skills WHERE ${SYSTEM_SKILL}`)).rows[0] as { version: string; active_revision_id: string };
const revisionId = async (hash: string) => (await superuserPool().query(
  `SELECT skill_revision_id FROM admin_skill_revisions WHERE ${SYSTEM_SKILL} AND bundle_hash = $1`, [hash])).rows[0]?.skill_revision_id as string;

/** The state right after migration 063: the seed is the only revision, and it is active. */
async function restoreSeedOnly() {
  const seedId = await revisionId(SEED_HASH);
  await superuserPool().query(`UPDATE admin_skills SET active_revision_id = $1, version = 1 WHERE ${SYSTEM_SKILL}`, [seedId]);
  await superuserPool().query(`DELETE FROM admin_skill_revisions WHERE ${SYSTEM_SKILL} AND skill_revision_id <> $1`, [seedId]);
  await superuserPool().query("UPDATE admin_skill_revisions SET review_status = 'active' WHERE skill_revision_id = $1", [seedId]);
}

/** Runs a state from before migration 069, then leaves the database as the
 *  migrations make it, for the tests that follow. */
async function inStateBefore069(run: () => Promise<void>) {
  await restoreSeedOnly();
  try {
    await run();
  } finally {
    await restoreSeedOnly();
    await applyMigration("069_interactive_ui_skill_draft.sql");
  }
}

/** A revision that an operator added to the system skill. */
async function addOperatorRevision(reviewStatus: "pending_review" | "active"): Promise<string> {
  const next = (await superuserPool().query(
    `SELECT COALESCE(MAX(revision_number), 0) + 1 AS next FROM admin_skill_revisions WHERE ${SYSTEM_SKILL}`)).rows[0].next as string;
  const metadata = { skillName: "Interactive UI", description: "Operator copy",
    associatedToolIds: ["render_interactive_ui"], instructions: OPERATOR_TEXT };
  return (await superuserPool().query(
    `INSERT INTO admin_skill_revisions (tenant_id, skill_id, revision_number, source_type, source_label, bundle_hash,
       validation_status, review_status, metadata, created_by)
     VALUES ('system', 'interactive-ui', $1, 'inline', 'operator', $2, 'validated', $3, $4::jsonb, 'operator')
     RETURNING skill_revision_id`,
    [next, `operator-hash-${next}`, reviewStatus, JSON.stringify(metadata)])).rows[0].skill_revision_id as string;
}

describe.skipIf(!adminDatabaseUrl())("interactive UI", () => {
  test("seeds one active inherited skill without changing existing tool permissions", async () => {
    const tenant = await seedTenantGraph();
    const before = (await superuserPool().query("SELECT * FROM tenant_settings ORDER BY tenant_id")).rows;

    // Every migration is applied already. Run both again: neither adds a row.
    await applyMigration("063_interactive_ui_skill.sql");
    await applyMigration("063_interactive_ui_skill.sql");
    await applyMigration("069_interactive_ui_skill_draft.sql");
    const afterFirstRun = await skillRow();
    await applyMigration("069_interactive_ui_skill_draft.sql");
    expect(await skillRow()).toEqual(afterFirstRun);

    expect((await superuserPool().query("SELECT * FROM tenant_settings ORDER BY tenant_id")).rows).toEqual(before);
    const store = new SkillConfigStore(appPool());
    const skills = (await store.listSkills(tenant.tenantId, false, false)).filter((skill) => skill.skillId === "interactive-ui");
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ isInherited: true, enabled: true,
      activeReviewStatus: "active", associatedToolIds: ["render_interactive_ui"] });
    expect(skills[0]!.instructions).toContain("window.cogniplane.sendMessage(text)");

    // The 063 seed stays as history. The new revision is active and tells the
    // model that the text goes to the message box as a draft.
    const rows = await revisions();
    expect(summary(rows)).toEqual([[1, "approved", SEED_HASH], [2, "active", DRAFT_HASH]]);
    expect(rows[0]!.instructions).toContain("asks the user to confirm");
    expect(rows[1]!.instructions).toContain("editable draft");
    expect(rows[1]!.instructions).toContain("at most 4,000 characters");
    expect(rows[1]!.instructions).not.toContain("asks the user to confirm");
    expect(rows[1]!.tool_ids).toEqual(["render_interactive_ui"]);
    expect(skills[0]!.instructions).toBe(rows[1]!.instructions);
    expect((await skillRow()).active_revision_id).toBe(await revisionId(DRAFT_HASH));
  });

  test("069 adds the new text after an operator's pending revision 2, and activates only the new revision", async () => {
    await inStateBefore069(async () => {
      const operatorId = await addOperatorRevision("pending_review");
      await applyMigration("069_interactive_ui_skill_draft.sql");

      const rows = await revisions();
      // The operator's revision 2 is untouched. The new text is revision 3.
      expect(summary(rows)).toEqual([
        [1, "approved", SEED_HASH],
        [2, "pending_review", "operator-hash-2"],
        [3, "active", DRAFT_HASH]
      ]);
      expect(rows[1]!.instructions).toBe(OPERATOR_TEXT);
      expect(rows[2]!.instructions).toContain("editable draft");
      const after = await skillRow();
      expect(after.active_revision_id).toBe(await revisionId(DRAFT_HASH));
      expect(after.active_revision_id).not.toBe(operatorId);
      expect(after.version).toBe("2");

      // Running it again changes nothing.
      await applyMigration("069_interactive_ui_skill_draft.sql");
      expect(summary(await revisions())).toEqual(summary(rows));
      expect(await skillRow()).toEqual(after);
    });
  });

  test("069 adds the new text but keeps the revision that an operator activated", async () => {
    await inStateBefore069(async () => {
      const operatorId = await addOperatorRevision("active");
      await superuserPool().query("UPDATE admin_skill_revisions SET review_status = 'approved' WHERE bundle_hash = $1", [SEED_HASH]);
      await superuserPool().query(`UPDATE admin_skills SET active_revision_id = $1, version = 5 WHERE ${SYSTEM_SKILL}`, [operatorId]);
      await applyMigration("069_interactive_ui_skill_draft.sql");

      const rows = await revisions();
      // The new text is there for an operator to activate, and it is not active.
      expect(summary(rows)).toEqual([
        [1, "approved", SEED_HASH],
        [2, "active", "operator-hash-2"],
        [3, "approved", DRAFT_HASH]
      ]);
      expect(rows[1]!.instructions).toBe(OPERATOR_TEXT);
      const after = await skillRow();
      expect(after).toEqual({ version: "5", active_revision_id: operatorId });

      await applyMigration("069_interactive_ui_skill_draft.sql");
      expect(summary(await revisions())).toEqual(summary(rows));
      expect(await skillRow()).toEqual(after);
    });
  });

  test("069 does not activate the new text when an operator changed the seed revision", async () => {
    await inStateBefore069(async () => {
      const seedId = await revisionId(SEED_HASH);
      const original = (await superuserPool().query(
        "SELECT metadata FROM admin_skill_revisions WHERE skill_revision_id = $1", [seedId])).rows[0].metadata as object;
      try {
        await superuserPool().query(
          "UPDATE admin_skill_revisions SET metadata = jsonb_set(metadata, '{instructions}', to_jsonb($2::text)) WHERE skill_revision_id = $1",
          [seedId, OPERATOR_TEXT]);
        await applyMigration("069_interactive_ui_skill_draft.sql");

        const rows = await revisions();
        expect(summary(rows)).toEqual([[1, "active", SEED_HASH], [2, "approved", DRAFT_HASH]]);
        expect(rows[0]!.instructions).toBe(OPERATOR_TEXT);
        expect(await skillRow()).toEqual({ version: "1", active_revision_id: seedId });
      } finally {
        await superuserPool().query("UPDATE admin_skill_revisions SET metadata = $2::jsonb WHERE skill_revision_id = $1",
          [seedId, JSON.stringify(original)]);
      }
    });
  });

  test("reads retained legacy inline resources and never writes new ones", async () => {
    const tenant = await seedTenantGraph();
    const messages = new MessageStore(appPool());
    const message = await messages.create({ tenantId: tenant.tenantId, userId: tenant.userId,
      sessionId: tenant.sessionId, role: "assistant", status: "completed", content: "Legacy widget." });
    const retained = [{ uri: "ui://legacy/card", mimeType: "text/html", text: "<b>retained-html</b>" }];
    // A caller built for the retired contract can still pass the old field.
    const row = (toolResultId: string, output: string) => ({
      tenantId: tenant.tenantId, userId: tenant.userId, sessionId: tenant.sessionId,
      messageId: message.messageId, toolResultId, kind: "mcp", title: "legacy_widget", status: "completed",
      command: null, cwd: null, server: "legacy", toolName: "legacy_widget", input: "{}", output, exitCode: null,
      durationMs: 1, textOffset: 0, uiResources: [{ uri: "ui://legacy/new", mimeType: "text/html", text: "<b>new-html</b>" }]
    }) as UpsertToolResultInput;
    const storedResources = async (toolResultId: string) => (await superuserPool().query(
      "SELECT ui_resources FROM message_tool_results WHERE tool_result_id = $1", [toolResultId])).rows[0]?.ui_resources;

    // Rows from the retired runtime keep their resources in this column.
    const legacyId = randomUUID();
    await messages.upsertToolResult(row(legacyId, "Legacy widget"));
    await superuserPool().query("UPDATE message_tool_results SET ui_resources = $2::jsonb WHERE tool_result_id = $1",
      [legacyId, JSON.stringify(retained)]);
    const transcript = await messages.listBySession(tenant.tenantId, tenant.sessionId, tenant.userId);
    expect(transcript.messages.flatMap((item) => item.toolResults).find((tool) => tool.toolResultId === legacyId))
      .toMatchObject({ output: "Legacy widget", uiResources: retained });

    const updated = await messages.upsertToolResult(row(legacyId, "Legacy widget, updated"));
    expect(updated).toMatchObject({ output: "Legacy widget, updated", uiResources: retained });
    expect(await storedResources(legacyId)).toEqual(retained);

    const newId = randomUUID();
    const created = await messages.upsertToolResult(row(newId, "[Embedded resource not displayed: ui://legacy/new (text/html)]"));
    expect(created).not.toHaveProperty("uiResources");
    expect(await storedResources(newId)).toBeNull();
  });

  test("retains a large widget for reload through the RLS store and denies another tenant", async () => {
    const tenant = await seedTenantGraph();
    const other = await seedTenantGraph();
    const messages = new MessageStore(appPool());
    const message = await messages.create({ tenantId: tenant.tenantId, userId: tenant.userId,
      sessionId: tenant.sessionId, role: "assistant", status: "completed", content: "Travel is the largest category." });
    const input = { title: "Spending", description: "Travel is the largest category.",
      html: '<button id="filter">Filter</button>' + " ".repeat(40_000) + '<script>document.querySelector("#filter").onclick = () => {};</script>' };
    const toolCallId = randomUUID();
    const mcpApp = { resourceUri: INTERACTIVE_UI_RESOURCE_URI, readOnly: true, input,
      result: { content: [{ type: "text", text: input.description }] } };
    await messages.upsertToolResult({ tenantId: tenant.tenantId, userId: tenant.userId, sessionId: tenant.sessionId,
      messageId: message.messageId, toolResultId: toolCallId, kind: "mcp", title: "render_interactive_ui",
      status: "completed", command: null, cwd: null, server: "managed-session-context", toolName: "render_interactive_ui",
      input: JSON.stringify(input), output: input.description, exitCode: null, durationMs: 1, textOffset: 0, mcpApp });
    const saved = await messages.getMcpAppCall(tenant.tenantId, tenant.sessionId, toolCallId);
    expect(saved?.app).toEqual(mcpApp);
    expect(await messages.getMcpAppCall(other.tenantId, tenant.sessionId, toolCallId)).toBeNull();
    const transcript = await messages.listBySession(tenant.tenantId, tenant.sessionId, tenant.userId);
    const tool = transcript.messages.find((row) => row.messageId === message.messageId)!.toolResults[0]!;
    expect(tool.input.length).toBeLessThan(input.html.length);
    expect(tool.mcpApp?.input).toEqual(input);
    expect(createInteractiveUiTool()[0]!.appResource!.render(tool.mcpApp!.input!)).toContain(input.html);
  });
});
