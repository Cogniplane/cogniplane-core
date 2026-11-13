import { describe, expect, it } from "vitest";
import type { TenantSettings } from "@cogniplane/shared-types";

import { makeTenantSettings as makeSettings } from "../test-helpers/tenant-settings";
import { buildDraft, type FormDraft } from "./tenant-settings-form.logic";
import {
  initialFormState,
  selectFormView,
  tenantSettingsFormReducer as reduce,
  type ApplyRequest,
  type TenantSettingsFormEvent as FormEvent,
  type TenantSettingsFormState as FormState
} from "./tenant-settings-form.state";

const run = (state: FormState, ...events: FormEvent[]) => events.reduce(reduce, state);
const edit = (patch: Partial<FormDraft>): FormEvent => ({ type: "draftEdited", recipe: (current) => ({ ...current, ...patch }) });
const typed = (developerInstructions: string) => edit({ developerInstructions });
const received = (settings: TenantSettings): FormEvent => ({ type: "settingsReceived", settings });
const succeeded = (sent: FormDraft): FormEvent => ({ type: "applySucceeded", sent });
const failed: FormEvent = { type: "applyFailed" };
const reviewOpened: FormEvent = { type: "reviewOpened" };

/** Captures the request as the component does, then starts it. */
function start(state: FormState): { state: FormState; request: ApplyRequest } {
  const request = { sent: state.draft, expectedVersion: state.baseline.version };
  return { state: reduce(state, { type: "applyStarted", request }), request };
}

/** A form on `settings` with `text` typed and the review open. */
function reviewing(settings: TenantSettings, text = "my draft"): FormState {
  return run(initialFormState(settings, null), typed(text), reviewOpened);
}

const view = (state: FormState, settings = state.observedSettings) => selectFormView(state, settings);

describe("initialization", () => {
  it("starts from the settings row when no draft is stored", () => {
    const settings = makeSettings({ version: 3, developerInstructions: "Saved" });
    expect(initialFormState(settings, null)).toEqual({
      baseline: settings,
      draft: buildDraft(settings),
      observedSettings: settings,
      reviewOpen: false,
      request: { phase: "idle" },
      pendingAcknowledgement: null,
      savedVersion: null
    });
  });

  it("keeps a restored draft object and its baseline when the row is not newer", () => {
    const baseline = makeSettings({ version: 4 });
    const draft = { ...buildDraft(baseline), developerInstructions: "mine" };
    const state = initialFormState(makeSettings({ version: 4 }), { baseline, draft });
    expect(state.baseline).toBe(baseline);
    expect(state.draft).toBe(draft);
  });

  it("moves a restored draft onto a newer row that changed no edited field", () => {
    const baseline = makeSettings({ version: 4 });
    const draft = { ...buildDraft(baseline), developerInstructions: "mine" };
    const newer = makeSettings({ version: 5, autoApproveReadOnlyTools: false });
    const state = initialFormState(newer, { baseline, draft });
    expect(state.baseline).toBe(newer);
    expect(state.draft).toMatchObject({ developerInstructions: "mine", autoApproveReadOnlyTools: false });
    expect(view(state)).toMatchObject({ conflictVersion: null, canApply: true });
  });

  it("keeps a restored draft on its baseline when the newer row changed an edited field", () => {
    const baseline = makeSettings({ version: 4 });
    const draft = { ...buildDraft(baseline), developerInstructions: "mine" };
    const state = initialFormState(makeSettings({ version: 5, developerInstructions: "theirs" }), { baseline, draft });
    expect(state.baseline).toBe(baseline);
    expect(state.draft).toBe(draft);
    expect(view(state)).toMatchObject({ conflictVersion: 5, canApply: false });
  });
});

describe("a confirmed save and its saved row", () => {
  const original = makeSettings({ version: 1 });
  const savedRow = makeSettings({ version: 2, developerInstructions: "Reviewed" });
  const orders: Array<[string, (sent: FormDraft) => FormEvent[]]> = [
    ["result, then row", (sent) => [succeeded(sent), received(savedRow)]],
    ["row, then result", (sent) => [received(savedRow), succeeded(sent)]]
  ];
  // An edit made while the save is sending stays. The rebase starts from the
  // sent draft, so an edit back to the old value also stays.
  const laterEdits: Array<[string, FormEvent[], string, number]> = [
    ["no later edit", [], "Reviewed", 0],
    ["a later edit", [typed("Typed later")], "Typed later", 1],
    ["a later edit that undoes the sent change", [typed("")], "", 1]
  ];

  describe.each(laterEdits)("with %s", (_name, edits, instructions, changeCount) => {
    const finish = (events: (sent: FormDraft) => FormEvent[]) => {
      const sending = start(reviewing(original, "Reviewed"));
      return { request: sending.request, state: run(sending.state, ...edits, ...events(sending.request.sent)) };
    };

    it.each(orders)("%s takes the row as the new baseline", (_order, events) => {
      const { request, state } = finish(events);
      expect(request).toEqual({ sent: expect.objectContaining({ developerInstructions: "Reviewed" }), expectedVersion: 1 });
      expect(state.baseline).toBe(savedRow);
      expect(state.draft.developerInstructions).toBe(instructions);
      expect(view(state).changes).toHaveLength(changeCount);
      expect(state).toMatchObject({
        savedVersion: 2,
        pendingAcknowledgement: null,
        request: { phase: "idle" },
        reviewOpen: false
      });
    });

    it("gets the same state in both orders", () => {
      const [first, second] = orders.map(([, events]) => finish(events).state);
      expect(first).toEqual(second);
    });
  });

  it("keeps the captured request while edits and rows arrive", () => {
    const { state, request } = start(reviewing(original, "Reviewed"));
    const later = run(state, typed("Typed later"), received(savedRow));
    expect(later.request).toEqual({ phase: "sending", request });
    if (later.request.phase !== "sending") throw new Error("Expected a sending request");
    expect(later.request.request.sent).toBe(request.sent);
    expect(later.baseline).toBe(original);
    expect(later.draft.developerInstructions).toBe("Typed later");
    expect(view(later)).toMatchObject({ conflictVersion: null, canApply: false });
  });
});

describe("a failed save", () => {
  const original = makeSettings({ version: 4 });
  const orders: Array<[string, (row: TenantSettings) => (state: FormState) => FormState]> = [
    ["result, then row", (row) => (state) => run(state, failed, received(row))],
    ["row during the request, then result", (row) => (state) => run(state, received(row), failed)]
  ];

  it.each(orders)("%s: retries on a newer row that changed no edited field", (_order, events) => {
    const row = makeSettings({ version: 5, autoApproveReadOnlyTools: false });
    const state = events(row)(start(reviewing(original)).state);
    expect(state.baseline).toBe(row);
    expect(state.draft).toMatchObject({ developerInstructions: "my draft", autoApproveReadOnlyTools: false });
    expect(state).toMatchObject({ request: { phase: "failed" }, reviewOpen: true });
    expect(view(state)).toMatchObject({ conflictVersion: null, canApply: true });
  });

  it.each(orders)("%s: keeps the baseline when the newer row changed an edited field", (_order, events) => {
    const row = makeSettings({ version: 5, developerInstructions: "theirs" });
    const state = events(row)(start(reviewing(original)).state);
    expect(state.baseline).toBe(original);
    expect(state.draft.developerInstructions).toBe("my draft");
    expect(state).toMatchObject({ request: { phase: "failed" }, reviewOpen: true });
    expect(view(state)).toMatchObject({ conflictVersion: 5, canApply: false });
  });

  it("is not taken as success when a matching row arrives; an explicit rebase leaves nothing to apply", () => {
    // The write persisted, then the response was lost.
    const row = makeSettings({ version: 5, developerInstructions: "my draft" });
    let state = run(start(reviewing(original)).state, failed, received(row));
    expect(state.baseline).toBe(original);
    expect(view(state).conflictVersion).toBe(5);

    state = reduce(state, { type: "rebaseRequested", settings: row });
    expect(state.baseline).toBe(row);
    expect(state).toMatchObject({ request: { phase: "idle" }, reviewOpen: true, savedVersion: null });
    expect(view(state)).toMatchObject({ changes: [], conflictVersion: null, canApply: false });
  });
});

describe("rows that are not newer", () => {
  const settings = makeSettings({ version: 3, developerInstructions: "current" });

  it.each([
    ["an equal version", makeSettings({ version: 3, developerInstructions: "other" })],
    ["an older version", makeSettings({ version: 2, developerInstructions: "stale" })]
  ])("%s does not move the baseline or replace edits", (_name, row) => {
    const before = run(initialFormState(settings, null), typed("mine"));
    const after = reduce(before, received(row));
    expect(after.observedSettings).toBe(row);
    expect(after.baseline).toBe(before.baseline);
    expect(after.draft).toBe(before.draft);
  });

  it("does not move back after a confirmed save", () => {
    const savedRow = makeSettings({ version: 2, developerInstructions: "Reviewed" });
    const { state, request } = start(reviewing(makeSettings({ version: 1 }), "Reviewed"));
    const saved = run(state, succeeded(request.sent), received(savedRow));
    const after = reduce(saved, received(makeSettings({ version: 1, developerInstructions: "stale" })));
    expect(after.baseline).toBe(savedRow);
    expect(after.draft).toBe(saved.draft);
  });

  it("returns the same state when the same row arrives again", () => {
    const row = makeSettings({ version: 5, autoApproveReadOnlyTools: false });
    const once = run(initialFormState(makeSettings({ version: 4 }), null), typed("mine"), received(row));
    expect(reduce(once, received(row))).toBe(once);
  });
});

describe("newer rows without a confirmed save", () => {
  it("follows a newer row while the draft has no changes", () => {
    const row = makeSettings({ version: 2, developerInstructions: "new from server" });
    const state = reduce(initialFormState(makeSettings({ developerInstructions: "old" }), null), received(row));
    expect(state.baseline).toBe(row);
    expect(state.draft).toEqual(buildDraft(row));
    expect(state.savedVersion).toBeNull();
  });

  it("follows a retained row when an edit removes the overlap, without a new row", () => {
    const original = makeSettings({ version: 4, developerInstructions: "Saved" });
    const row = makeSettings({ version: 5, developerInstructions: "theirs" });
    let state = run(initialFormState(original, null), typed("Saved!"), edit({ allowCommandExecution: true }), received(row));
    expect(state.baseline).toBe(original);
    expect(view(state).conflictVersion).toBe(5);

    state = reduce(state, typed("Saved"));
    expect(state.baseline).toBe(row);
    expect(state.draft).toMatchObject({ developerInstructions: "theirs", allowCommandExecution: true });
    expect(view(state).changes.map((change) => change.field)).toEqual(["allowCommandExecution"]);
  });

  it("treats the approval mode and its granular categories as one field", () => {
    const granular = { granular: { sandbox_approval: true, mcp_elicitations: false, rules: false, request_permissions: false, skill_approval: false } };
    const original = makeSettings({ version: 4, approvalPolicy: granular as never });
    const draft = run(initialFormState(original, null), edit({
      granularFlags: { ...buildDraft(original).granularFlags, rules: true }
    }));
    expect(view(draft).changes.map((change) => change.field)).toEqual(["granularCategories"]);

    const modeChanged = reduce(draft, received(makeSettings({ version: 5, approvalPolicy: "on-request" })));
    expect(modeChanged.baseline).toBe(original);
    expect(view(modeChanged).conflictVersion).toBe(5);

    const otherChanged = makeSettings({ version: 5, approvalPolicy: granular as never, developerInstructions: "theirs" });
    expect(reduce(draft, received(otherChanged)).baseline).toBe(otherChanged);
  });
});

describe("the conflict reads the current settings prop", () => {
  it("shows a conflict before the reducer receives the row", () => {
    const state = run(initialFormState(makeSettings({ version: 4 }), null), typed("mine"));
    const row = makeSettings({ version: 5, developerInstructions: "theirs" });
    expect(view(state, row)).toMatchObject({ conflictVersion: 5, canApply: false });
  });

  it("shows no conflict while a save is sending or waits for its row", () => {
    const row = makeSettings({ version: 5, developerInstructions: "theirs" });
    const { state, request } = start(reviewing(makeSettings({ version: 4 })));
    expect(view(state, row).conflictVersion).toBeNull();
    expect(view(reduce(state, succeeded(request.sent)), row).conflictVersion).toBeNull();
  });
});

describe("review", () => {
  const settings = makeSettings({ allowCommandExecution: true });
  const clean = initialFormState(settings, null);

  it.each([
    ["no changes", clean, false],
    ["only a change that saves the same value", run(clean, typed("  ")), false],
    ["a host that the server would refuse", run(clean, edit({ sandboxEgressText: "*.com" })), false],
    ["a valid change", run(clean, typed("mine")), true]
  ])("with %s", (_name, state, opens) => {
    expect(reduce(state, reviewOpened).reviewOpen).toBe(opens);
  });

  it("clears a failure, but not a request that is sending", () => {
    const afterFailure = run(start(reviewing(settings)).state, failed, { type: "reviewClosed" });
    expect(afterFailure.request).toEqual({ phase: "failed" });
    expect(reduce(afterFailure, reviewOpened)).toMatchObject({ reviewOpen: true, request: { phase: "idle" } });

    const { state: sending, request } = start(reviewing(settings));
    expect(reduce(sending, reviewOpened).request).toEqual({ phase: "sending", request });
  });

  it("closes without clearing a failure", () => {
    const state = run(start(reviewing(settings)).state, failed, { type: "reviewClosed" });
    expect(state).toMatchObject({ reviewOpen: false, request: { phase: "failed" } });
  });
});

describe("edits", () => {
  it("clear the saved notice and keep the request state", () => {
    const settings = makeSettings();
    const withNotice = { ...run(initialFormState(settings, null), typed("mine")), savedVersion: 2 };
    expect(reduce(withNotice, typed("more")).savedVersion).toBeNull();

    const afterFailure = run(start(reviewing(settings)).state, failed, typed("more"));
    expect(afterFailure.request).toEqual({ phase: "failed" });
    const { state: sending, request } = start(reviewing(settings));
    expect(reduce(sending, typed("more")).request).toEqual({ phase: "sending", request });
  });
});

describe("rebase and discard", () => {
  const original = makeSettings({ version: 4, developerInstructions: "Saved" });
  const row = makeSettings({ version: 5, developerInstructions: "theirs", autoApproveReadOnlyTools: false });

  it("rebase puts the edits on the row, keeps the review open and keeps the saved notice", () => {
    const conflicted = { ...run(start(reviewing(original)).state, failed, received(row)), savedVersion: 3 };
    const state = reduce(conflicted, { type: "rebaseRequested", settings: row });
    expect(state.baseline).toBe(row);
    expect(state.draft).toMatchObject({ developerInstructions: "my draft", autoApproveReadOnlyTools: false });
    expect(state).toMatchObject({ reviewOpen: true, request: { phase: "idle" }, savedVersion: 3 });
  });

  it("discard takes a newer row, closes the review and clears a failure", () => {
    const conflicted = run(start(reviewing(original)).state, failed, received(row));
    const state = reduce(conflicted, { type: "discarded", settings: row });
    expect(state.baseline).toBe(row);
    expect(state.draft).toEqual(buildDraft(row));
    expect(state).toMatchObject({ reviewOpen: false, request: { phase: "idle" } });
  });

  it("discard keeps the baseline when the row is not newer", () => {
    const state = run(initialFormState(original, null), typed("mine"), { type: "discarded", settings: original });
    expect(state.baseline).toBe(original);
    expect(state.draft).toEqual(buildDraft(original));
  });

  it("discard does not cancel a request that is sending", () => {
    const { state, request } = start(reviewing(original));
    expect(reduce(state, { type: "discarded", settings: original }).request).toEqual({ phase: "sending", request });
  });
});

describe("apply guard", () => {
  const settings = makeSettings({ version: 4, allowCommandExecution: true });
  const clean = initialFormState(settings, null);
  const conflictRow = makeSettings({ version: 5, allowCommandExecution: true, developerInstructions: "theirs" });

  it.each([
    ["a valid change", run(clean, typed("mine")), settings, true],
    ["no changes", clean, settings, false],
    ["a host that the server would refuse", run(clean, typed("mine"), edit({ sandboxEgressText: "*.com" })), settings, false],
    ["a request that is sending", start(reviewing(settings)).state, settings, false],
    ["a newer row that changed an edited field", run(clean, typed("mine")), conflictRow, false]
  ])("%s", (_name, state, current, allowed) => {
    expect(selectFormView(state, current).canApply).toBe(allowed);
  });
});

// These sequences document the current behavior between a confirmed save and
// its row. They do not endorse it. Fix them in a separate change.
describe("before the saved row arrives (current behavior)", () => {
  const original = makeSettings({ version: 4, developerInstructions: "old" });
  const savedRow = makeSettings({ version: 5, developerInstructions: "mine" });

  function confirmed(): { state: FormState; request: ApplyRequest } {
    const { state, request } = start(reviewing(original, "mine"));
    return { state: reduce(state, succeeded(request.sent)), request };
  }

  it("Discard restores the old value, and the saved row then shows it as an unsaved change", () => {
    const { state: saved, request } = confirmed();
    const discarded = reduce(saved, { type: "discarded", settings: original });
    expect(discarded.baseline).toBe(original);
    expect(discarded.draft.developerInstructions).toBe("old");
    expect(discarded.pendingAcknowledgement).toEqual({ sent: request.sent });

    const state = reduce(discarded, received(savedRow));
    expect(state.baseline).toBe(savedRow);
    expect(state.draft.developerInstructions).toBe("old");
    expect(view(state).changes).toHaveLength(1);
    expect(state).toMatchObject({ savedVersion: 5, pendingAcknowledgement: null, reviewOpen: false });
  });

  it("a second apply sends the old version, and a failure then shows nothing to apply after the row", () => {
    const { state: saved } = confirmed();
    expect(view(saved)).toMatchObject({ hasChanges: true, conflictVersion: null, canApply: true });

    const second = start(reduce(saved, reviewOpened));
    expect(second.request.expectedVersion).toBe(4);
    const state = run(second.state, failed, received(savedRow));
    expect(state.baseline).toBe(savedRow);
    expect(state).toMatchObject({
      reviewOpen: true,
      request: { phase: "failed" },
      pendingAcknowledgement: null,
      savedVersion: 5
    });
    expect(view(state)).toMatchObject({ changes: [], canApply: false });
  });
});
