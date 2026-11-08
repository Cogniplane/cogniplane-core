import { MODEL_PROVIDER_META, type ModelProvider } from "@cogniplane/shared-types";

import type { OutgoingMail } from "./mail-sender.js";
import { escapeHtml, FOOTER, formatWhen, headerSafe } from "./security-notices.js";

// The text of the owner notice for a change of a data setting: a tenant
// setting that changes where the tenant's data goes, a change that makes a
// control weaker (Policy Center rules, PII protection), or a skill release
// (docs/architecture/sensitive-changes.md). Every owner of the tenant gets
// it, also for a change that an owner made. For a WorkOS tenant it is the
// only check, so its text is fixed:
// - The subject and the first sentence never change.
// - Text that a person can choose (the organization name, an MCP server id,
//   a display name) appears only after a label, cleaned to one short line,
//   and escaped in the HTML. The organization ID next to the name cannot
//   change, so a renamed organization cannot pass for another one.
// - It never carries a value (a key, an address, a secret): a value can hold
//   a credential, and the owner reads the setting in the app. It has no link.
// Changes are combined: one notice lists the changes of one window
// (mail-outbox.ts, OWNER_NOTICE_WINDOW_MS), at most OWNER_NOTICE_MAX_CHANGES.

export const SETTING_CHANGE_SUBJECT = "A data setting of your organization was changed";
export const OWNER_NOTICE_MAX_CHANGES = 10;
export const OWNER_NOTICE_WINDOW_MINUTES = 15;

/** A change of the Policy Center rules that makes the policy weaker. `ruleName` is the admin's text. */
export type PolicyRuleChange = {
  setting: "policy_rules";
  change: "rule_added" | "rule_changed" | "rule_removed" | "order_changed";
  ruleId: string | null;
  ruleName: string | null;
};

/** A skill release: what runs for users changes. */
export type SkillReleaseChange = {
  setting: "skill_release";
  skillId: string;
  change: "revision_activated" | "published" | "submission_released" | "project_released";
  /** Who gets the skill after the release; null when the release keeps the audience. */
  audience: "test-users" | "members" | null;
  /** A project skill: its project. */
  projectId?: string;
};

/** A change of a data setting, as the notice names it. `fields` are labels that the code chooses. */
export type DataSettingChange =
  | { setting: "provider_key"; provider: ModelProvider; removed: boolean }
  | { setting: "tenant_settings"; fields: string[] }
  | { setting: "mcp_server"; serverId: string; created: boolean }
  | { setting: "mcp_server_audience"; serverId: string }
  | { setting: "mcp_widget_domain"; serverId: string }
  | { setting: "integration"; integrationName: string; fields: string[] }
  // The current name is in the notice's "Organization" field.
  | { setting: "organization_name"; previousName: string }
  | PolicyRuleChange
  | { setting: "pii_protection"; fields: string[] }
  | SkillReleaseChange
  | { setting: "skill_marketplace" };

const POLICY_RULE_CHANGES: Record<PolicyRuleChange["change"], string> = {
  rule_added: "A rule was added.",
  rule_changed: "A rule was changed.",
  rule_removed: "A rule was removed.",
  order_changed: "The order of the rules was changed."
};

const SKILL_RELEASES: Record<SkillReleaseChange["change"], string> = {
  revision_activated: "A revision of the skill was released.",
  published: "The skill was released to all members.",
  submission_released: "A skill that a member submitted was released.",
  project_released: "A project skill was released to the people who can edit the project."
};

const AUDIENCES: Record<NonNullable<SkillReleaseChange["audience"]>, string> = {
  "test-users": "Test users",
  members: "All members"
};

/** One change in a notice: what changed, who changed it, and when (ISO time). */
export type NoticeChange = {
  change: DataSettingChange;
  actor: { displayName: string | null; email: string | null };
  at: string;
};

/** The changes that one notice lists. `more`: there were more changes than the notice lists. */
export type NoticeDigest = { changes: NoticeChange[]; more: boolean };

export type SettingChangeNoticeContext = {
  to: string;
  organization: { name: string; id: string };
};

type Field = [label: string, value: string];

/** Labelled lines of one change. Values that a person chooses are cleaned to one short line. */
export function describeChange(change: DataSettingChange): Field[] {
  switch (change.setting) {
    case "provider_key":
      return [
        ["Setting", "Provider API key"],
        ["Provider", MODEL_PROVIDER_META[change.provider]?.label ?? headerSafe(change.provider)],
        ["Change", change.removed ? "The key was removed." : "A new key was saved."]
      ];
    case "tenant_settings":
      return [["Setting", "Agent and model settings"], ["Changed fields", change.fields.map((field) => headerSafe(field)).join(", ")]];
    case "mcp_server":
      return [
        ["Setting", "MCP server"],
        ["MCP server ID", headerSafe(change.serverId)],
        ["Change", change.created ? "The server was added." : "The address, the secret, or other settings were saved."]
      ];
    case "mcp_server_audience":
      return [["Setting", "Who can use a shared MCP server"], ["MCP server ID", headerSafe(change.serverId)]];
    case "mcp_widget_domain":
      return [["Setting", "Approved widget domain of an MCP server"], ["MCP server ID", headerSafe(change.serverId)]];
    case "integration":
      return [
        ["Setting", "Integration settings"],
        ["Integration", headerSafe(change.integrationName)],
        ["Changed fields", change.fields.map((field) => headerSafe(field)).join(", ")]
      ];
    case "organization_name":
      return [["Setting", "Organization name"], ["Previous name", headerSafe(change.previousName) || "(no name)"], ["Change", "The organization was renamed."]];
    case "policy_rules":
      return [
        ["Setting", "Policy Center rules"],
        ...(change.ruleName === null ? [] : [["Rule", headerSafe(change.ruleName) || "(no name)"] as Field]),
        ...(change.ruleId === null ? [] : [["Rule ID", headerSafe(change.ruleId)] as Field]),
        ["Change", `${POLICY_RULE_CHANGES[change.change]} Some tool calls now get a less strict result.`]
      ];
    case "pii_protection":
      return [["Setting", "PII protection"], ["Weaker fields", change.fields.map((field) => headerSafe(field)).join(", ")]];
    case "skill_release":
      return [
        ["Setting", "Skill release"],
        ["Skill ID", headerSafe(change.skillId)],
        ...(change.projectId === undefined ? [] : [["Project ID", headerSafe(change.projectId)] as Field]),
        ...(change.audience === null ? [] : [["Audience", AUDIENCES[change.audience]] as Field]),
        ["Change", SKILL_RELEASES[change.change]]
      ];
    case "skill_marketplace":
      return [["Setting", "Skill marketplace address"], ["Change", "A new address was saved."]];
  }
}

function actorText(actor: NoticeChange["actor"]): string {
  const name = actor.displayName ? headerSafe(actor.displayName) : "";
  const email = actor.email ? headerSafe(actor.email, 320) : "";
  if (name && email) return `${name} (${email})`;
  return name || email || "Unknown";
}

function changeFields(item: NoticeChange): Field[] {
  return [...describeChange(item.change), ["Changed by", actorText(item.actor)], ["Time", formatWhen(new Date(item.at))]];
}

const AFTER = [
  "These settings control where Cogniplane sends the data of your organization, how Cogniplane protects that data, and which skills the agents of your users get.",
  "If you know about these changes, you do not need to do anything.",
  "If you do not know about them, examine the audit log now and change the settings back. Somebody else can have access to an administrator account. A new password or \"Sign out everywhere\" does not undo a setting change.",
  `You get at most one email about these changes in ${OWNER_NOTICE_WINDOW_MINUTES} minutes. The audit log has every change.`,
  "You get this message because you are an owner of this organization."
];

export function renderSettingChangeNotice(digest: NoticeDigest, context: SettingChangeNoticeContext): OutgoingMail {
  const organization: Field[] = [
    ["Organization", headerSafe(context.organization.name) || "(no name)"],
    ["Organization ID", headerSafe(context.organization.id)]
  ];
  const blocks: Field[][] = [organization, ...digest.changes.map(changeFields)];
  const more = digest.more ? ["And other changes. Examine the audit log."] : [];

  const textBlock = (fields: Field[]) => fields.map(([label, value]) => `${label}: ${value}`).join("\n");
  const text = ["Hello,", `${SETTING_CHANGE_SUBJECT}.`, ...blocks.map(textBlock), ...more, ...AFTER, FOOTER].join("\n\n") + "\n";

  const htmlBlock = (fields: Field[]) =>
    `<p>${fields.map(([label, value]) => `<strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}`).join("<br>")}</p>`;
  const html = [
    "<!doctype html>",
    '<html><body style="font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.5; color: #1f2328;">',
    "<p>Hello,</p>",
    `<p>${escapeHtml(SETTING_CHANGE_SUBJECT)}.</p>`,
    ...blocks.map(htmlBlock),
    ...[...more, ...AFTER].map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`),
    `<p style="color: #59636e; font-size: 13px;">${escapeHtml(FOOTER)}</p>`,
    "</body></html>"
  ].join("\n");
  return { to: context.to, subject: SETTING_CHANGE_SUBJECT, text, html };
}

/** Adds a change to a digest: the first OWNER_NOTICE_MAX_CHANGES are listed, the rest only marked. */
export function addChange(digest: NoticeDigest | null, change: NoticeChange): NoticeDigest {
  const current = digest ?? { changes: [], more: false };
  return current.changes.length < OWNER_NOTICE_MAX_CHANGES
    ? { changes: [...current.changes, change], more: current.more }
    : { changes: current.changes, more: true };
}
