import { describe, expect, it } from "vitest";
import { PERSON_ACCESS_REASONS, type PersonAccessItem, type PersonAccessReason } from "@cogniplane/shared-types";

import {
  defaultStatusFilter,
  defaultsNote,
  itemSummary,
  kindLabel,
  memberAction,
  personTabFromParam,
  personTabHref,
  reasonText,
  resourceHref,
  resourceLabel,
  sourceNote,
  visibleItems
} from "./person-skills-connections.logic";

function item(overrides: Partial<PersonAccessItem> & Pick<PersonAccessItem, "id" | "name" | "status">): PersonAccessItem {
  return { kind: "skill", runtimeSource: "organization", adminPageSource: "organization", signIn: null, gates: [], ...overrides };
}

describe("person tab URL", () => {
  it("reads only the known tab value and keeps other parameters when switching", () => {
    expect(personTabFromParam("skills-connections")).toBe("skills-connections");
    expect(personTabFromParam("settings")).toBe("activity");
    expect(personTabFromParam(null)).toBe("activity");
    const params = new URLSearchParams("from=people&tab=skills-connections");
    expect(personTabHref("/admin/users/dana", params, "activity")).toBe("/admin/users/dana?from=people");
    expect(personTabHref("/admin/users/dana", new URLSearchParams(), "skills-connections")).toBe("/admin/users/dana?tab=skills-connections");
  });
});

describe("visibleItems", () => {
  const items = [
    item({ id: "b", name: "beta", status: "included" }),
    item({ id: "z", name: "Zeta", status: "unknown" }),
    item({ id: "a", name: "Alpha", status: "excluded" }),
    item({ id: "c", name: "alpha", status: "excluded", kind: "connection" })
  ];

  it("puts excluded before unknown and hides included under the default filter", () => {
    expect(visibleItems(items, "not_included", "").map((row) => row.id)).toEqual(["a", "c", "z"]);
    expect(visibleItems(items, "all", "").map((row) => row.id)).toEqual(["a", "c", "z", "b"]);
    expect(visibleItems(items, "included", "").map((row) => row.id)).toEqual(["b"]);
  });

  it("matches the search against name or ID, ignoring case and outer spaces", () => {
    expect(visibleItems(items, "all", "  ZET ").map((row) => row.id)).toEqual(["z"]);
    expect(visibleItems(items, "all", "c").map((row) => row.id)).toEqual(["c"]);
  });

  it("defaults to everything when nothing needs attention", () => {
    expect(defaultStatusFilter({ excluded: 0, unknown: 0, included: 3 })).toBe("all");
    expect(defaultStatusFilter({ excluded: 0, unknown: 1, included: 3 })).toBe("not_included");
  });
});

describe("row wording and actions", () => {
  it("offers a member link only for member-side reasons", () => {
    expect(memberAction("not_in_member_defaults", "Dana")?.path).toBe("/settings/capabilities?tab=defaults");
    expect(memberAction("member_not_connected", "Dana")?.path).toBe("/settings/connections");
    expect(memberAction("member_must_reconnect", "Dana")?.path).toBe("/settings/connections");
    for (const reason of ["turned_off", "test_users_only", "not_allowed_for_organization", "no_instructions",
      "personal_sign_in_not_configured", "sign_in_not_accepted", "legacy_settings_pending"] as const) {
      expect(memberAction(reason, "Dana")).toBeNull();
    }
  });

  it("encodes resource IDs in admin links", () => {
    expect(resourceHref({ kind: "skill", id: "a b" })).toBe("/admin/skills?skill=a%20b");
    expect(resourceHref({ kind: "connection", id: "x&y" })).toBe("/admin/connections?connection=x%26y");
  });

  it("says an unexplained unknown result could not be checked", () => {
    const unknown = item({ id: "u", name: "U", status: "unknown", gates: [{ gate: "personal_sign_in", result: "unknown" }] });
    expect(itemSummary(unknown, "Dana", false)).toBe("Could not be checked.");
  });

  it("labels the version the member gets and names the admin version the link opens", () => {
    const fallback = item({ id: "s", name: "S", status: "included", runtimeSource: "system", adminPageSource: "organization" });
    expect(kindLabel(fallback)).toBe("Skill · Built in");
    expect(sourceNote(fallback, "Dana")).toBe("Uses the built-in version. The organization copy is not available to Dana.");
    expect(resourceLabel(fallback)).toBe("Open the organization copy");

    const same = item({ id: "o", name: "O", status: "included" });
    expect(kindLabel(same)).toBe("Skill · Organization");
    expect(sourceNote(same, "Dana")).toBeNull();
    expect(resourceLabel(same)).toBe("Open the skill");

    // No eligible version: label the admin page version and add no note.
    const none = item({ id: "n", name: "N", status: "excluded", kind: "connection", signIn: "personal", runtimeSource: null, adminPageSource: "system" });
    expect(kindLabel(none)).toBe("Connection · Built in · Personal sign-in");
    expect(sourceNote(none, "Dana")).toBeNull();
    expect(resourceLabel(none)).toBe("Open the connection");
  });

  it("keeps the empty-defaults header short; the notice gives the reason", () => {
    expect(defaultsNote({ isTestUser: false, defaults: "empty" }, "Dana")).toBe("Dana chose no defaults for new chats.");
  });
});

describe("reasonText", () => {
  const expected: Record<PersonAccessReason, string> = {
    turned_off: "Turned off.",
    test_users_only: "Released to test users only.",
    not_allowed_for_organization: "Not allowed for the organization.",
    not_in_member_defaults: "Not in Dana's defaults for new chats.",
    no_instructions: "Has no instructions, so the agent does not get it.",
    member_not_connected: "Dana has not signed in to this connection.",
    member_must_reconnect: "Dana must sign in again.",
    personal_sign_in_not_configured: "Personal sign-in is not set up for this connection.",
    sign_in_not_accepted: "The connection's current setup does not accept Dana's sign-in.",
    legacy_settings_pending: "Saved connection settings need review. Sign-in cannot be checked until then."
  };

  it.each(PERSON_ACCESS_REASONS)("explains %s in one sentence", (reason) => {
    expect(reasonText(reason, "Dana")).toBe(expected[reason]);
  });

  it("gives every reason its own sentence", () => {
    const sentences = PERSON_ACCESS_REASONS.map((reason) => reasonText(reason, "Dana"));
    expect(new Set(sentences).size).toBe(PERSON_ACCESS_REASONS.length);
  });
});
