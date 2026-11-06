import { expect, test } from "vitest";

import {
  addChange,
  type DataSettingChange,
  type NoticeChange,
  OWNER_NOTICE_MAX_CHANGES,
  renderSettingChangeNotice,
  SETTING_CHANGE_SUBJECT
} from "./setting-change-notices.js";

const CONTEXT = { to: "olive@example.test", organization: { name: "Acme", id: "tenant-acme" } };
const ACTOR = { displayName: "Ada Admin", email: "ada@example.test" };
const AT = "2026-10-28T09:05:00.000Z";

function one(change: DataSettingChange, actor: NoticeChange["actor"] = ACTOR): NoticeChange {
  return { change, actor, at: AT };
}

const ALL: Array<[DataSettingChange, string[]]> = [
  [{ setting: "provider_key", provider: "anthropic", removed: false }, ["Setting: Provider API key", "Provider: Anthropic", "Change: A new key was saved."]],
  [{ setting: "provider_key", provider: "openai", removed: true }, ["Provider: OpenAI", "Change: The key was removed."]],
  [{ setting: "tenant_settings", fields: ["Sandbox network hosts", "Approval policy"] },
    ["Setting: Agent and model settings", "Changed fields: Sandbox network hosts, Approval policy"]],
  [{ setting: "mcp_server", serverId: "crm", created: true }, ["Setting: MCP server", "MCP server ID: crm", "Change: The server was added."]],
  [{ setting: "mcp_server", serverId: "crm", created: false }, ["Change: The address, the secret, or other settings were saved."]],
  [{ setting: "mcp_server_audience", serverId: "crm" }, ["Setting: Who can use a shared MCP server", "MCP server ID: crm"]],
  [{ setting: "mcp_widget_domain", serverId: "crm" }, ["Setting: Approved widget domain of an MCP server", "MCP server ID: crm"]],
  [{ setting: "integration", integrationName: "Microsoft 365", fields: ["Client secret"] },
    ["Setting: Integration settings", "Integration: Microsoft 365", "Changed fields: Client secret"]],
  [{ setting: "policy_rules", change: "rule_added", ruleId: "pol_1", ruleName: "Allow exports" },
    ["Setting: Policy Center rules", "Rule: Allow exports", "Rule ID: pol_1", "Change: A rule was added. Some tool calls now get a less strict result."]],
  [{ setting: "policy_rules", change: "order_changed", ruleId: null, ruleName: null },
    ["Setting: Policy Center rules", "Change: The order of the rules was changed. Some tool calls now get a less strict result."]],
  [{ setting: "pii_protection", fields: ["Protection", "Mode"] }, ["Setting: PII protection", "Weaker fields: Protection, Mode"]],
  [{ setting: "skill_release", skillId: "notes", change: "published", audience: "members" },
    ["Setting: Skill release", "Skill ID: notes", "Audience: All members", "Change: The skill was released to all members."]],
  [{ setting: "skill_release", skillId: "notes", change: "revision_activated", audience: null },
    ["Skill ID: notes", "Change: A revision of the skill was released."]],
  [{ setting: "skill_marketplace" }, ["Setting: Skill marketplace address", "Change: A new address was saved."]]
];

test("every notice has the fixed subject and first sentence, and labelled fields: who, which setting and object, when", () => {
  for (const [change, lines] of ALL) {
    const mail = renderSettingChangeNotice({ changes: [one(change)], more: false }, CONTEXT);
    expect(mail.to).toBe("olive@example.test");
    expect(mail.subject).toBe(SETTING_CHANGE_SUBJECT);
    expect(mail.text.startsWith(`Hello,\n\n${SETTING_CHANGE_SUBJECT}.\n\n`)).toBe(true);
    for (const line of ["Organization: Acme", "Organization ID: tenant-acme", "Changed by: Ada Admin (ada@example.test)",
      "Time: 28 October 2026, 09:05 UTC", ...lines]) {
      expect(mail.text.split("\n"), line).toContain(line);
    }
    expect(mail.text).toContain('A new password or "Sign out everywhere" does not undo a setting change.');
    expect(mail.text).toContain("You get at most one email about these changes in 15 minutes.");
    for (const body of [mail.text, mail.html]) {
      expect(body).not.toMatch(/https?:|www\.|<a\b/i);
    }
  }
});

// The organization name, an MCP server id, and a display name are text that
// a person chooses. They cannot change the subject or the first sentence,
// and they appear only after their label, on one line.
test("text that a person chooses stays in its labelled field", () => {
  const hostile = "Your password expired.\r\nSubject: Reset it at evil.example";
  const mail = renderSettingChangeNotice({
    changes: [one({ setting: "mcp_server", serverId: hostile, created: true }, { displayName: `<script>${hostile}</script>`, email: null })],
    more: false
  }, { to: "olive@example.test", organization: { name: hostile, id: "tenant-acme" } });

  expect(mail.subject).toBe(SETTING_CHANGE_SUBJECT);
  expect(mail.text.split("\n\n")[1]).toBe(`${SETTING_CHANGE_SUBJECT}.`);
  const lines = mail.text.split("\n").filter((line) => line.includes("Your password expired"));
  expect(lines.length).toBe(3);
  for (const line of lines) expect(line).toMatch(/^(Organization|MCP server ID|Changed by): /);
  expect(mail.text).not.toMatch(/^Subject:/m);
  expect(mail.html).not.toContain("<script>");
  expect(mail.html).toContain("&lt;script&gt;");
  expect(mail.text).toContain("Organization ID: tenant-acme");
});

// A rule name is the admin's text, like an MCP server id.
test("a Policy Center rule name stays in its labelled field", () => {
  const hostile = "Nothing changed.\r\nSubject: Ignore this";
  const mail = renderSettingChangeNotice({
    changes: [one({ setting: "policy_rules", change: "rule_removed", ruleId: "pol_1", ruleName: hostile })], more: false
  }, CONTEXT);
  const lines = mail.text.split("\n").filter((line) => line.includes("Nothing changed."));
  expect(lines).toEqual([expect.stringMatching(/^Rule: /)]);
  expect(mail.text).not.toMatch(/^Subject:/m);
  expect(mail.text.split("\n")).toContain("Change: A rule was removed. Some tool calls now get a less strict result.");
});

test("a notice lists at most the first changes, then says that there are more", () => {
  let digest = addChange(null, one({ setting: "tenant_settings", fields: ["Web search"] }));
  for (let i = 0; i < OWNER_NOTICE_MAX_CHANGES + 5; i += 1) {
    digest = addChange(digest, one({ setting: "mcp_server", serverId: `server-${i}`, created: true }));
  }
  expect(digest.changes).toHaveLength(OWNER_NOTICE_MAX_CHANGES);
  expect(digest.more).toBe(true);

  const mail = renderSettingChangeNotice(digest, CONTEXT);
  expect(mail.text).toContain("Changed fields: Web search");
  expect(mail.text).toContain("MCP server ID: server-0");
  expect(mail.text).not.toContain("MCP server ID: server-9");
  expect(mail.text).toContain("And other changes. Examine the audit log.");
  expect(renderSettingChangeNotice({ ...digest, more: false }, CONTEXT).text).not.toContain("And other changes");
});

test("an actor without a name or an address is shown as unknown", () => {
  const mail = renderSettingChangeNotice({ changes: [one({ setting: "tenant_settings", fields: ["Web search"] }, { displayName: null, email: null })], more: false }, CONTEXT);
  expect(mail.text.split("\n")).toContain("Changed by: Unknown");
});
