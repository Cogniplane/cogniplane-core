import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { MCP_APP_MESSAGE_MAX_CHARS } from "@cogniplane/shared-types";
import { describe, expect, it } from "vitest";

import { createInteractiveUiTool, INTERACTIVE_UI_RESOURCE_URI, MAX_INTERACTIVE_UI_HTML_LENGTH } from "./interactive-ui.js";
import type { ToolExecutionContext } from "../auth/tool-execution-context-store.js";

const tool = createInteractiveUiTool()[0]!;
const context = {} as ToolExecutionContext;
const input = { title: "Spend by category", description: "Travel accounts for half of the total.",
  html: '<button id="update">Update</button><script>document.querySelector("#update").onclick = () => {};</script>' };

describe("render_interactive_ui", () => {
  it("returns a text summary without sending the generated code back to the model", async () => {
    expect(await tool.handler({ context, arguments: input })).toEqual({
      title: input.title, description: input.description, characters: input.html.length
    });
    expect(tool.readOnly).toBe(true);
    expect(tool.appResource?.uri).toBe(INTERACTIVE_UI_RESOURCE_URI);
    expect(tool.appResource?.render(input)).toContain(input.html);
  });

  it.each([
    { ...input, title: " " },
    { ...input, title: "a".repeat(121) },
    { ...input, description: "" },
    { ...input, description: "a".repeat(1_001) },
    { ...input, html: " " },
    { ...input, html: "\u0000" },
    { ...input, html: 1 },
    { ...input, html: "a".repeat(MAX_INTERACTIVE_UI_HTML_LENGTH + 1) }
  ])("rejects invalid input at execution and when reopening the saved widget", async (invalid) => {
    await expect(tool.handler({ context, arguments: invalid })).rejects.toThrow(/Shrink the widget/);
    expect(() => tool.appResource?.render(invalid)).toThrow(/Shrink the widget/);
  });

  it("accepts the size boundary and ignores model-supplied host configuration", async () => {
    const args = { ...input, html: "a".repeat(MAX_INTERACTIVE_UI_HTML_LENGTH),
      csp: { connectDomains: ["https://example.test"] }, tenantId: "other", toolContextId: "bound" };
    expect(await tool.handler({ context, arguments: args })).toEqual({
      title: input.title, description: input.description, characters: MAX_INTERACTIVE_UI_HTML_LENGTH
    });
    const document = tool.appResource!.render(args);
    expect(document).not.toContain("https://example.test");
    expect(document).not.toContain('tenantId');
  });

  // The host limit is 4,000 characters. The frontend test pins the same value.
  // The tool description and the skill text tell the model the limit, so they
  // must say the same number as the constant.
  it("tells the model that sendMessage puts a draft in the message box, with the host limit", () => {
    const limit = MCP_APP_MESSAGE_MAX_CHARS.toLocaleString("en-US");
    expect(MCP_APP_MESSAGE_MAX_CHARS).toBe(4_000);
    expect(tool.description).toContain(`at most ${limit} characters`);
    expect(tool.description).toContain("message box");
    expect(tool.description).toContain("sends nothing and starts no turn");
    expect(tool.description).not.toContain("must confirm");
  });

  it("states the same limit in the seeded skill text that migration 069 adds", async () => {
    const sql = await readFile(new URL("../../../db/migrations/069_interactive_ui_skill_draft.sql", import.meta.url), "utf8");
    // The skill text is the part between the dollar quotes.
    const instructions = sql.split("$instructions$")[1] ?? "";
    expect(instructions).toContain(`plain text of at most ${MCP_APP_MESSAGE_MAX_CHARS.toLocaleString("en-US")} characters`);
    expect(instructions).toContain("editable draft");
    expect(instructions).toContain("The host does not send the text.");
    expect(instructions).not.toContain("asks the user to confirm");
    // The new revision has its own hash.
    expect(sql).toContain("md5('interactive-ui:instructions:v2')");
  });

  it("finds the seed of migration 063 by its content, and does not assume a revision number", async () => {
    const dir = new URL("../../../db/migrations/", import.meta.url);
    const seedSql = await readFile(new URL("063_interactive_ui_skill.sql", dir), "utf8");
    const sql = await readFile(new URL("069_interactive_ui_skill_draft.sql", dir), "utf8");
    // 069 activates the new revision only while the active revision still has the
    // exact text of 063. The md5 in 069 must be the md5 of that text.
    const seedInstructions = seedSql.split("$instructions$")[1] ?? "";
    expect(seedInstructions).toContain("# Interactive UI");
    const seedMd5 = createHash("md5").update(seedInstructions, "utf8").digest("hex");
    expect(sql).toContain(`md5(metadata ->> 'instructions') = '${seedMd5}'`);
    expect(sql).toContain("md5('interactive-ui:instructions:v1')");
    // An operator can add revisions to the system skill. No fixed number.
    expect(sql).not.toMatch(/revision_number\s*(=|IN)\s*[\d(]/);
    expect(sql).toContain("COALESCE(MAX(revision_number), 0) + 1");
  });
});
