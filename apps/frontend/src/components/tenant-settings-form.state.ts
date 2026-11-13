import type { TenantSettings } from "@cogniplane/shared-types";
import {
  buildDraft,
  parseSandboxEgressText,
  type FormDraft,
  type ParsedSandboxEgress
} from "./tenant-settings-form.logic";
import { diffAgentBehavior, rebaseDraft, type BehaviorChange } from "./agent-behavior-impact";

// State and transitions of the Agent behavior form. The reducer is pure. The
// component sends the save, writes the draft store, asks for a reload and
// moves focus. Then it reports each result here as an event.

/** What one apply sent. The component captures it before it waits for the save. */
export type ApplyRequest = { sent: FormDraft; expectedVersion: number };

/**
 * The apply request. A failure stays until the administrator opens the review,
 * rebases, discards or applies again. An edit does not clear it.
 */
export type RequestState =
  | { phase: "idle" }
  | { phase: "sending"; request: ApplyRequest }
  | { phase: "failed" };

export type TenantSettingsFormState = {
  /**
   * The saved settings that the draft started from. Its version goes into
   * expectedVersion. It moves to a newer row only when the draft keeps all of
   * its edits, after a confirmed save, or when the administrator asks.
   */
  baseline: TenantSettings;
  draft: FormDraft;
  /** The last settings row that the page gave. It is not the highest version seen. */
  observedSettings: TenantSettings;
  reviewOpen: boolean;
  request: RequestState;
  /**
   * The draft of the last confirmed save, until a newer row arrives. The save
   * callback returns only true or false, so the next newer row counts as the
   * saved one. A second apply can start before that row arrives.
   */
  pendingAcknowledgement: { sent: FormDraft } | null;
  /** The version in the "Saved as" notice. An edit clears it. */
  savedVersion: number | null;
};

export type TenantSettingsFormEvent =
  /** The recipe must be pure. Read DOM values before you send the event. */
  | { type: "draftEdited"; recipe: (current: FormDraft) => FormDraft }
  | { type: "reviewOpened" }
  | { type: "reviewClosed" }
  | { type: "applyStarted"; request: ApplyRequest }
  | { type: "applySucceeded"; sent: FormDraft }
  | { type: "applyFailed" }
  | { type: "settingsReceived"; settings: TenantSettings }
  /** `settings` is the current settings prop. */
  | { type: "rebaseRequested"; settings: TenantSettings }
  /** `settings` is the current settings prop. */
  | { type: "discarded"; settings: TenantSettings };

const IDLE: RequestState = { phase: "idle" };

// The approval mode and its granular categories rebase together, so they conflict together.
function conflictField(field: string): string {
  return field === "granularCategories" ? "approvalPolicy" : field;
}

/** True when `latest` changed a field that `changes` also changed. Both start from `baselineDraft`. */
function overlaps(baselineDraft: FormDraft, changes: BehaviorChange[], latest: FormDraft): boolean {
  const changedSince = new Set(diffAgentBehavior(baselineDraft, latest).map((change) => conflictField(change.field)));
  return changes.some((change) => changedSince.has(conflictField(change.field)));
}

function hostsBlocked(egress: ParsedSandboxEgress): boolean {
  return egress.errors.length > 0 || egress.tooMany;
}

function clearFailure(request: RequestState): RequestState {
  return request.phase === "failed" ? IDLE : request;
}

/**
 * Moves the baseline to a newer observed row when no edit can be lost. Runs
 * after the initializer and after each transition. It does nothing while a
 * save is sending, or when the observed row is not newer than the baseline.
 */
function reconcile(state: TenantSettingsFormState): TenantSettingsFormState {
  const row = state.observedSettings;
  if (state.request.phase === "sending" || row.version <= state.baseline.version) return state;
  const latest = buildDraft(row);
  if (state.pendingAcknowledgement) {
    // Our own save arrived. Keep any edit made after it was sent.
    return {
      ...state,
      baseline: row,
      draft: rebaseDraft(state.pendingAcknowledgement.sent, state.draft, latest),
      pendingAcknowledgement: null,
      savedVersion: row.version
    };
  }
  const baselineDraft = buildDraft(state.baseline);
  const changes = diffAgentBehavior(baselineDraft, state.draft);
  // An overlapping change: the administrator decides (see conflictVersion).
  if (changes.length > 0 && overlaps(baselineDraft, changes, latest)) return state;
  // Nothing to lose: follow the newer row and keep the edits.
  return { ...state, baseline: row, draft: rebaseDraft(baselineDraft, state.draft, latest) };
}

/**
 * The first state. A restored draft keeps its baseline. Reconciliation then
 * moves it to a newer row when no edit can be lost.
 */
export function initialFormState(
  settings: TenantSettings,
  restored: { baseline: TenantSettings; draft: FormDraft } | null
): TenantSettingsFormState {
  return reconcile({
    baseline: restored?.baseline ?? settings,
    draft: restored?.draft ?? buildDraft(settings),
    observedSettings: settings,
    reviewOpen: false,
    request: IDLE,
    pendingAcknowledgement: null,
    savedVersion: null
  });
}

function transition(state: TenantSettingsFormState, event: TenantSettingsFormEvent): TenantSettingsFormState {
  switch (event.type) {
    case "draftEdited":
      return { ...state, draft: event.recipe(state.draft), savedVersion: null };
    case "reviewOpened": {
      // Only a valid draft with changes opens the review. The component shows
      // the host problems itself.
      const changes = diffAgentBehavior(buildDraft(state.baseline), state.draft);
      if (changes.length === 0 || hostsBlocked(parseSandboxEgressText(state.draft.sandboxEgressText))) return state;
      return { ...state, reviewOpen: true, request: clearFailure(state.request) };
    }
    case "reviewClosed":
      return state.reviewOpen ? { ...state, reviewOpen: false } : state;
    case "applyStarted":
      // The component checked its guard and sends this request, so the reducer always accepts it.
      return { ...state, request: { phase: "sending", request: event.request } };
    case "applySucceeded":
      return { ...state, request: IDLE, pendingAcknowledgement: { sent: event.sent }, reviewOpen: false };
    case "applyFailed":
      return { ...state, request: { phase: "failed" } };
    case "settingsReceived":
      return event.settings === state.observedSettings ? state : { ...state, observedSettings: event.settings };
    case "rebaseRequested":
      return {
        ...state,
        baseline: event.settings,
        draft: rebaseDraft(buildDraft(state.baseline), state.draft, buildDraft(event.settings)),
        request: clearFailure(state.request)
      };
    case "discarded": {
      const latest = event.settings.version > state.baseline.version ? event.settings : state.baseline;
      return {
        ...state,
        baseline: latest,
        draft: buildDraft(latest),
        reviewOpen: false,
        request: clearFailure(state.request)
      };
    }
  }
}

export function tenantSettingsFormReducer(
  state: TenantSettingsFormState,
  event: TenantSettingsFormEvent
): TenantSettingsFormState {
  const next = transition(state, event);
  // Each state is already reconciled, so a state that did not change needs no new pass.
  return next === state ? state : reconcile(next);
}

export type FormView = {
  baselineDraft: FormDraft;
  changes: BehaviorChange[];
  hasChanges: boolean;
  egress: ParsedSandboxEgress;
  /** The server would refuse the host list, so the draft cannot be reviewed or saved. */
  hostsBlocked: boolean;
  /**
   * A newer saved version that changed a field that the draft also changed, or
   * null. A save on another admin page also moves the version. When it changed
   * no field of the draft, the draft follows it without a conflict.
   */
  conflictVersion: number | null;
  /** The component also checks its `saving` prop and its synchronous apply guard. */
  canApply: boolean;
};

/**
 * Values that the form derives from its state. `settings` is the current prop,
 * so a conflict shows in the render that receives the row, before the reducer
 * gets the row from an effect.
 */
export function selectFormView(state: TenantSettingsFormState, settings: TenantSettings): FormView {
  const baselineDraft = buildDraft(state.baseline);
  const changes = diffAgentBehavior(baselineDraft, state.draft);
  const hasChanges = changes.length > 0;
  const egress = parseSandboxEgressText(state.draft.sandboxEgressText);
  const blocked = hostsBlocked(egress);
  const sending = state.request.phase === "sending";
  // While a save is sending, or until a confirmed save gets its row, a newer
  // row is not a conflict.
  const conflict =
    hasChanges &&
    !sending &&
    state.pendingAcknowledgement === null &&
    settings.version > state.baseline.version &&
    overlaps(baselineDraft, changes, buildDraft(settings));
  const conflictVersion = conflict ? settings.version : null;
  return {
    baselineDraft,
    changes,
    hasChanges,
    egress,
    hostsBlocked: blocked,
    conflictVersion,
    canApply: !sending && hasChanges && !blocked && conflictVersion === null
  };
}
