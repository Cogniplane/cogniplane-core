"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import Link from "next/link";

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import type { PolicyLintWarning, PolicyMonitorSummaryResponse, PolicyRule } from "@cogniplane/shared-types";

import {
  ALL_EFFECTS,
  ALL_SEVERITIES,
  ALL_TURN_CONTEXTS,
  draftFromRule,
  draftToInput,
  draftToPatch,
  describeConditions,
  EFFECT_LABELS,
  emptyDraft,
  isDraftValid,
  keepDraftChanges,
  reorderedRuleIds,
  ruleConflictRows,
  SEVERITY_LABELS,
  toggleInList,
  TURN_CONTEXT_LABELS,
  type PolicyRuleDraft,
  type PolicyRuleSave,
  type PolicyRuleSaveResult,
  type RuleConflictRow
} from "./admin-policy-form.logic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { PILL_AMBER } from "../../../lib/ui-tokens";
import { OverviewRow } from "../overview-row";
import { approvalCount, monitorDecisionsHref, plural } from "./policy-monitor.logic";

type Props = {
  rules: PolicyRule[];
  lintWarnings: PolicyLintWarning[];
  busyKey: string | null;
  rulesState?: "loading" | "unavailable" | "stale" | "current";
  rulesError?: string | null;
  refreshing?: boolean;
  onRetryRules?: () => void;
  lintState?: "checking" | "unavailable" | "current";
  lintError?: string | null;
  onRetryLint?: () => void;
  actionError?: string | null;
  /** Resolves when the save ends. After `conflict` or `missing`, the rules are already read again. */
  onSave: (save: PolicyRuleSave) => Promise<PolicyRuleSaveResult>;
  onDelete: (ruleId: string) => Promise<boolean> | void;
  onReorder: (ruleIds: string[]) => void;
  /** The last 7 days of Monitor records. Each rule shows its own counts. */
  evidence?: PolicyMonitorSummaryResponse;
  /** Shown after the rules, such as the tool-call test. */
  children?: ReactNode;
};

const LINT_KIND_LABELS: Record<PolicyLintWarning["kind"], string> = {
  shadowed: "Unreachable",
  duplicate: "Duplicate",
  unknown_condition: "Unknown condition"
};

/**
 * What stops the save of an edited rule until the admin acts. `review`: the
 * list has a newer revision; the admin compares it with the draft and
 * chooses. `loading` and `unavailable`: the server refused the save, and the
 * saved rule is being read or could not be read. `deleted`: the rule is gone.
 */
type EditConflict =
  | { kind: "review"; saved: PolicyRule }
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "deleted" };

function editConflict(input: {
  base: PolicyRule | null;
  saved: PolicyRule | undefined;
  refusal: "conflict" | "missing" | null;
  saving: boolean;
  listCurrent: boolean;
  refreshing: boolean;
}): EditConflict | null {
  const { base, saved, refusal } = input;
  // A new rule has nothing to compare. The list can show this editor's own
  // save before the save answers, so nothing is compared during a save.
  if (!base || input.saving) return null;
  if (refusal === "missing" || (input.listCurrent && !saved)) return { kind: "deleted" };
  if (saved && saved.revision > base.revision) return { kind: "review", saved };
  if (refusal === "conflict") return { kind: input.refreshing ? "loading" : "unavailable" };
  return null;
}

export function AdminPolicyRulesCard({ rules, lintWarnings, busyKey, onSave, onDelete, onReorder, evidence, children, rulesState = "current", rulesError, refreshing = false, onRetryRules, lintState = "current", lintError, onRetryLint, actionError }: Props) {
  const actionLock = useRef(false);
  const [localPending, setLocalPending] = useState<"save" | "delete" | null>(null);
  const [draft, setDraft] = useState<PolicyRuleDraft | null>(null);
  // The saved rule that an edit started from. The save sends its revision,
  // and the server refuses the save when the rule has another one. Only the
  // admin's choice after a comparison moves it to a newer revision; a list
  // refresh never does.
  const [base, setBase] = useState<PolicyRule | null>(null);
  // The server's answer to the last save of this edit.
  const [refusal, setRefusal] = useState<"conflict" | "missing" | null>(null);
  function openEditor(next: PolicyRuleDraft | null, from: PolicyRule | null) {
    setDraft(next);
    setBase(from);
    setRefusal(null);
  }

  // Group lint warnings by the rule they're about so each row can show its own.
  const warningsByRule = new Map<string, PolicyLintWarning[]>();
  for (const warning of lintWarnings) {
    const list = warningsByRule.get(warning.ruleId) ?? [];
    list.push(warning);
    warningsByRule.set(warning.ruleId, list);
  }

  // Drag-to-reorder is disabled while editing (the draft form changes the
  // layout) and while a reorder is in flight.
  const busy = busyKey !== null || localPending !== null;
  const editable = rulesState === "current" && !refreshing;
  const reorderable = !draft && !busy && editable && rules.length > 1;
  const saving = busyKey === "submit" || localPending === "save";
  const savedRule = draft?.ruleId ? rules.find((rule) => rule.ruleId === draft.ruleId) : undefined;
  const conflict = editConflict({ base, saved: savedRule, refusal, saving, listCurrent: editable, refreshing });
  // An edited rule that is no longer in the list keeps its editor above the list.
  const orphaned = draft !== null && draft.ruleId !== null && !savedRule;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    const ruleIds = over ? reorderedRuleIds(rules, active.id, over.id) : null;
    if (ruleIds && reorderable) onReorder(ruleIds);
  }

  // Closing an editor removes the focused control, so move focus to the button that opened it.
  // After a save, the rules refresh and that button stays disabled until the refresh ends,
  // so the request waits for it. Focus that the user moved elsewhere stays where it is.
  const returnFocus = useRef<string | null>(null);
  const restoreFocus = useCallback(() => {
    const target = returnFocus.current ? document.getElementById(returnFocus.current) as HTMLButtonElement | null : null;
    if (!target || target.disabled) return;
    returnFocus.current = null;
    const active = document.activeElement;
    if (active === null || active === document.body) target.focus();
  }, []);
  useEffect(() => {
    // A failed refresh ends the wait; a later recovery must not move focus.
    if (rulesState !== "current") returnFocus.current = null;
    else if (editable && !busy) requestAnimationFrame(restoreFocus);
  }, [rulesState, editable, busy, restoreFocus]);
  function closeEditor(focusId: string) {
    returnFocus.current = focusId;
    openEditor(null, null);
    requestAnimationFrame(restoreFocus);
  }

  async function handleSave() {
    if (!draft || !isDraftValid(draft) || busy || actionLock.current || !editable || conflict) return;
    let save: PolicyRuleSave;
    if (draft.ruleId === null) save = { ruleId: null, input: draftToInput(draft) };
    else if (base) save = { ruleId: draft.ruleId, patch: draftToPatch(draft, base) };
    else return;
    actionLock.current = true;
    setLocalPending("save");
    try {
      const result = await onSave(save);
      if (result === "saved") closeEditor(draft.ruleId ? editButtonId(draft.ruleId) : NEW_RULE_ID);
      else if (result === "conflict" || result === "missing") setRefusal(result);
    } finally {
      actionLock.current = false;
      setLocalPending(null);
    }
  }

  // The admin's choice after a comparison. The next save sends the revision of
  // the saved rule that the admin compared. Focus moves to Save, the next step.
  function resolveConflict(saved: PolicyRule, keepMine: boolean) {
    if (!draft || !base || busy || !editable) return;
    document.getElementById(SAVE_RULE_ID)?.focus();
    setDraft(keepMine ? keepDraftChanges(base, saved, draft) : draftFromRule(saved));
    setBase(saved);
    setRefusal(null);
  }

  // A deleted rule cannot take the draft. The admin can create it again.
  function recreateRule() {
    if (!draft || busy) return;
    openEditor({ ...draft, ruleId: null }, null);
  }

  const conflictNotice = conflict && draft ? (
    <RuleConflictNotice
      id={CONFLICT_ID}
      conflict={conflict}
      base={base}
      draft={draft}
      choiceDisabled={busy || !editable}
      loadDisabled={busy}
      onUseSaved={(saved) => resolveConflict(saved, false)}
      onKeepMine={(saved) => resolveConflict(saved, true)}
      onLoadSaved={onRetryRules}
      onCreateNew={recreateRule}
    />
  ) : null;

  async function handleDelete(ruleId: string) {
    if (busy || actionLock.current || !editable) return;
    actionLock.current = true;
    setLocalPending("delete");
    try {
      const ok = await onDelete(ruleId);
      if (ok) closeEditor(NEW_RULE_ID);
    } finally {
      actionLock.current = false;
      setLocalPending(null);
    }
  }

  const creating = draft !== null && draft.ruleId === null;
  const deleting = localPending === "delete" || (busyKey?.startsWith("delete-") ?? false);

  return (
    <section aria-labelledby="policy-rules-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="policy-rules-title" className="text-lg font-semibold text-on-surface">Rules</h2>
        {/* An open editor has unsaved edits, so the button cancels it before it starts a new rule. */}
        <Button id={NEW_RULE_ID} type="button" variant="outline" size="sm" aria-expanded={creating} disabled={busy || !editable} onClick={() => openEditor(draft ? null : emptyDraft(), null)}>
          {draft ? "Cancel" : "New rule"}
        </Button>
      </div>
      <p className="mt-1 text-sm text-on-surface-variant">
        The first matching rule decides. Drag the handle to change the order. A tool call that matches no rule is allowed.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        <p role={rulesError ? "alert" : "status"} className={rulesError ? "text-danger" : "text-on-surface-variant"}>
          {rulesState === "loading" ? "Loading rules..." : rulesState === "unavailable" ? `Rules unavailable. ${rulesError ?? "Try again."}` : rulesState === "stale" ? `Showing saved rules. The latest read failed. ${rulesError ?? "Try again."}` : refreshing ? "Refreshing rules. Showing saved rules." : "Rules are up to date."}
        </p>
        {onRetryRules ? <Button type="button" variant="outline" size="sm" aria-disabled={refreshing || busy} onClick={() => { if (!refreshing && !busy) onRetryRules(); }}>
          {rulesError ? "Retry rules" : "Refresh rules"}
        </Button> : null}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
        <p role={lintError ? "alert" : "status"} className={lintError ? "text-danger" : "text-on-surface-variant"}>
          {lintState === "checking" ? "Checking rule warnings..." : lintState === "unavailable" ? `Rule warnings unavailable. ${lintError ?? "Try again."}` : lintWarnings.length === 0 ? "No rule warnings found." : `${lintWarnings.length} rule warnings found.`}
        </p>
        {onRetryLint ? <Button type="button" variant="outline" size="sm" aria-disabled={lintState === "checking" || busy} onClick={() => { if (lintState !== "checking" && !busy) onRetryLint(); }}>
          {lintError ? "Retry warnings" : "Check warnings"}
        </Button> : null}
      </div>
      {actionError && !draft ? <p role="alert" className="mt-3 text-sm text-danger">{actionError}</p> : null}
      {busyKey === "reorder" ? <p role="status" className="mt-3 text-sm text-on-surface-variant">Saving rule order...</p> : null}
      {(creating || orphaned) && draft ? <div className="mt-4"><RuleEditor
            draft={draft}
            onChange={setDraft}
            onCancel={() => closeEditor(NEW_RULE_ID)}
            onSave={handleSave}
            saving={saving}
            deleting={deleting}
            error={actionError}
            disabled={busy || !editable}
            conflict={conflictNotice}
          /></div> : null}

      <div className="mt-3 border-t border-outline-variant">
        {rules.length === 0 ? (
          rulesState === "current" && !refreshing ? <p className="py-4 text-sm text-on-surface-variant">No rules. Every tool call is allowed.</p> : null
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={rules.map((r) => r.ruleId)} strategy={verticalListSortingStrategy}>
              <ul className="divide-y divide-outline-variant">
                {rules.map((rule) => (
                  <SortableRuleRow
                    key={rule.ruleId}
                    rule={rule}
                    warnings={warningsByRule.get(rule.ruleId) ?? []}
                    reorderable={reorderable}
                    showHandle={rules.length > 1}
                    evidence={evidence}
                    editing={draft?.ruleId === rule.ruleId}
                    // One editor at a time, so an open draft is never replaced without a warning.
                    editDisabled={busy || !editable || draft !== null && draft.ruleId !== rule.ruleId}
                    onEdit={() => draft?.ruleId === rule.ruleId ? closeEditor(editButtonId(rule.ruleId)) : openEditor(draftFromRule(rule), rule)}
                  >
                    {draft?.ruleId === rule.ruleId ? <RuleEditor
            draft={draft}
            onChange={setDraft}
            onCancel={() => closeEditor(editButtonId(rule.ruleId))}
            onSave={handleSave}
            saving={saving}
            deleting={deleting}
            error={actionError}
            disabled={busy || !editable}
            conflict={conflictNotice}
            onDelete={() => { void handleDelete(rule.ruleId); }}
          /> : null}
                  </SortableRuleRow>
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}
        <div className="border-t border-outline-variant">{children}</div>
      </div>
    </section>
  );
}

const NEW_RULE_ID = "policy-new-rule";
const SAVE_RULE_ID = "policy-save-rule";
const CONFLICT_ID = "policy-rule-conflict";
const editButtonId = (ruleId: string) => `policy-edit-${ruleId}`;

const CHANGED_BY: Record<RuleConflictRow["changedBy"], string> = {
  you: "Changed by you",
  "someone else": "Changed by someone else",
  both: "Changed by you and someone else"
};

/**
 * Why the edited rule cannot be saved yet. After a newer revision it shows
 * the saved rule next to the draft and asks the admin to choose; the draft
 * stays until then. After a delete it offers to create the rule again.
 */
function RuleConflictNotice({ id, conflict, base, draft, choiceDisabled, loadDisabled, onUseSaved, onKeepMine, onLoadSaved, onCreateNew }: {
  id: string;
  conflict: EditConflict;
  base: PolicyRule | null;
  draft: PolicyRuleDraft;
  choiceDisabled: boolean;
  loadDisabled: boolean;
  onUseSaved: (saved: PolicyRule) => void;
  onKeepMine: (saved: PolicyRule) => void;
  onLoadSaved?: () => void;
  onCreateNew: () => void;
}) {
  const box = "flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning-surface p-3 text-sm text-on-surface";
  if (conflict.kind === "deleted") {
    return (
      <div className={box}>
        <p id={id} role="alert">
          <span className="font-semibold">Someone deleted this rule after you opened it.</span>{" "}
          Your draft is kept, but you cannot save it to this rule.
        </p>
        <Button type="button" size="sm" variant="outline" className="self-start" disabled={choiceDisabled} onClick={onCreateNew}>
          Create it as a new rule
        </Button>
      </div>
    );
  }
  const loading = conflict.kind === "loading";
  return (
    <div className={box}>
      <p id={id} role="alert">
        <span className="font-semibold">Someone changed this rule after you opened it.</span> Your draft is kept.
      </p>
      {conflict.kind === "review" && base ? (
        <RuleComparison base={base} saved={conflict.saved} draft={draft} disabled={choiceDisabled} onUseSaved={onUseSaved} onKeepMine={onKeepMine} />
      ) : (
        <>
          {conflict.kind === "unavailable" ? <p className="text-danger">Could not load the saved rule.</p> : null}
          {onLoadSaved ? (
            <Button type="button" size="sm" variant="outline" className="self-start" aria-disabled={loading || loadDisabled}
              onClick={() => { if (!loading && !loadDisabled) onLoadSaved(); }}>
              {loading ? "Loading the saved rule..." : "Load the saved rule"}
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}

function RuleComparison({ base, saved, draft, disabled, onUseSaved, onKeepMine }: {
  base: PolicyRule;
  saved: PolicyRule;
  draft: PolicyRuleDraft;
  disabled: boolean;
  onUseSaved: (saved: PolicyRule) => void;
  onKeepMine: (saved: PolicyRule) => void;
}) {
  const rows = ruleConflictRows(base, saved, draft);
  const cell = "border-t border-warning/30 py-1.5 pr-3 align-top";
  return (
    <>
      <p>Compare your draft with the saved rule, then choose what to keep.</p>
      {rows.length > 0 ? (
        <table aria-label="Saved rule and your draft" className="w-full text-left">
          <thead>
            <tr className="text-on-surface-variant">
              <th scope="col" className="py-1.5 pr-3 font-medium">Field</th>
              <th scope="col" className="py-1.5 pr-3 font-medium">Saved now</th>
              <th scope="col" className="py-1.5 font-medium">Your draft</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.field}>
                <th scope="row" className={`${cell} font-medium`}>
                  {row.label}
                  <span className="block text-xs font-normal text-on-surface-variant">{CHANGED_BY[row.changedBy]}</span>
                </th>
                <td className={cell}>{row.saved}</td>
                <td className={`${cell} pr-0`}>{row.draft}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p>The saved rule has the same values as your draft.</p>}
      {saved.priority !== base.priority ? <p>Its place in the rule order changed too. The first matching rule decides.</p> : null}
      <p className="text-on-surface-variant">Keep my changes keeps each field that you changed. The other fields take the saved values.</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => onUseSaved(saved)}>Use the saved rule</Button>
        <Button type="button" size="sm" disabled={disabled} onClick={() => onKeepMine(saved)}>Keep my changes</Button>
      </div>
    </>
  );
}

/** "3 would-be blocks, 1 approval request in 7 days", linked to those rule matches. Null when the rule did not match. */
function ruleEvidence(rule: PolicyRule, evidence: PolicyMonitorSummaryResponse | undefined): ReactNode {
  const counts = evidence?.rules.find((entry) => entry.ruleId === rule.ruleId)?.counts;
  if (!evidence || !counts) return null;
  const approvals = approvalCount(counts);
  const text = [
    counts.block ? plural(counts.block, "would-be block") : null,
    approvals ? plural(approvals, "approval request") : null
  ].filter(Boolean).join(", ");
  if (!text) return null;
  return (
    <Link href={monitorDecisionsHref(evidence, { ruleId: rule.ruleId })} aria-label={`${text} in 7 days for ${rule.name}`} className="underline underline-offset-4">
      {text} in 7 days
    </Link>
  );
}

function SortableRuleRow({
  rule,
  warnings,
  reorderable,
  showHandle,
  evidence,
  editing,
  editDisabled,
  onEdit,
  children
}: {
  rule: PolicyRule;
  warnings: PolicyLintWarning[];
  reorderable: boolean;
  showHandle: boolean;
  evidence: PolicyMonitorSummaryResponse | undefined;
  editing: boolean;
  editDisabled: boolean;
  onEdit: () => void;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: rule.ruleId,
    disabled: !reorderable
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : undefined
  };
  const matches = ruleEvidence(rule, evidence);

  return (
    <li ref={setNodeRef} style={style} className="flex items-start gap-2 bg-background">
      {showHandle ? (
        // While an editor is open the handle stays in place but hidden, so rows do not shift.
        <button
          type="button"
          aria-label={`Reorder ${rule.name}`}
          className={`mt-4 cursor-grab touch-none rounded px-1 text-on-surface-faint hover:text-on-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary active:cursor-grabbing ${reorderable ? "" : "invisible"}`}
          {...attributes}
          {...listeners}
        >
          ⠿
        </button>
      ) : null}
      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        <OverviewRow
          title={rule.name}
          status={<>
            {EFFECT_LABELS[rule.effect]}: {describeConditions(rule.conditions)}{rule.enabled ? "" : " (off)"}.
            {matches ? <span className="block">{matches}</span> : null}
            {warnings.map((warning, i) => (
              <span key={i} className="mt-1 flex items-start gap-1.5 text-xs text-warning">
                <span className={`${PILL_AMBER} shrink-0`}>{LINT_KIND_LABELS[warning.kind]}</span>
                <span>{warning.message}</span>
              </span>
            ))}
          </>}
        >
          <Button id={editButtonId(rule.ruleId)} type="button" variant="outline" size="sm" aria-label={`Edit ${rule.name}`} aria-expanded={editing} disabled={editDisabled} onClick={onEdit}>
            Edit
          </Button>
        </OverviewRow>
        {children ? <div className="pb-4">{children}</div> : null}
      </div>
    </li>
  );
}

function RuleEditor({
  draft,
  onChange,
  onCancel,
  onSave,
  saving,
  deleting,
  disabled,
  error,
  conflict,
  onDelete
}: {
  draft: PolicyRuleDraft;
  onChange: (next: PolicyRuleDraft) => void;
  onCancel: () => void;
  onSave: () => void;
  saving: boolean;
  deleting: boolean;
  disabled: boolean;
  error?: string | null;
  /** Why the draft cannot be saved yet (RuleConflictNotice). Save waits until it is gone. */
  conflict?: ReactNode;
  onDelete?: () => void;
}) {
  const errorId = useId();
  const actions = useRef<HTMLDivElement>(null);
  const errorElement = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error && actions.current?.contains(document.activeElement)) errorElement.current?.scrollIntoView({ block: "nearest" });
  }, [error]);
  const update = (patch: Partial<PolicyRuleDraft>) => onChange({ ...draft, ...patch });

  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-lg border border-outline bg-surface-container-low p-4">
      <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="policy-name">Name</Label>
        <Input
          id="policy-name"
          value={draft.name}
          onChange={(e) => update({ name: e.target.value })}
          placeholder="Block external writes"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="policy-effect">Effect</Label>
        <Select value={draft.effect} onValueChange={(v) => update({ effect: v as typeof draft.effect })}>
          <SelectTrigger id="policy-effect">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ALL_EFFECTS.map((effect) => (
              <SelectItem key={effect} value={effect}>
                {EFFECT_LABELS[effect]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="policy-tools">Tool names (comma-separated)</Label>
          <Input
            id="policy-tools"
            value={draft.toolNamesText}
            onChange={(e) => update({ toolNamesText: e.target.value })}
            placeholder="github_write_file, notion_create_page"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="policy-categories">Categories / servers (comma-separated)</Label>
          <Input
            id="policy-categories"
            value={draft.categoriesText}
            onChange={(e) => update({ categoriesText: e.target.value })}
            placeholder="github, notion"
          />
        </div>
      </div>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-sm leading-none font-medium">Severities</legend>
        <div className="flex flex-wrap gap-3">
          {ALL_SEVERITIES.map((severity) => (
            <label key={severity} className="flex items-center gap-2 text-sm text-on-surface-variant">
              <input
                type="checkbox"
                checked={draft.severities.includes(severity)}
                onChange={(e) => update({ severities: toggleInList(draft.severities, severity, e.target.checked) })}
              />
              {SEVERITY_LABELS[severity]}
            </label>
          ))}
        </div>
        <p className="text-xs text-on-surface-faint">
          None checked matches any severity. A rule matches when every filled condition matches.
        </p>
      </fieldset>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-sm leading-none font-medium">Turn context</legend>
        <div className="flex flex-wrap gap-3">
          {ALL_TURN_CONTEXTS.map((tc) => (
            <label key={tc} className="flex items-center gap-2 text-sm text-on-surface-variant">
              <input
                type="checkbox"
                checked={draft.turnContexts.includes(tc)}
                onChange={(e) => update({ turnContexts: toggleInList(draft.turnContexts, tc, e.target.checked) })}
              />
              {TURN_CONTEXT_LABELS[tc]}
            </label>
          ))}
        </div>
        <p className="text-xs text-on-surface-faint">
          None checked matches any turn. Choose Scheduled to control runs that nobody watches.
        </p>
      </fieldset>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="policy-reason">Explanation shown to the user (optional)</Label>
        <Textarea
          id="policy-reason"
          value={draft.reason}
          onChange={(e) => update({ reason: e.target.value })}
          rows={2}
        />
      </div>

      <label className="flex items-center gap-2 text-sm text-on-surface-variant">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => update({ enabled: e.target.checked })}
        />
        Enabled
      </label>

      </fieldset>
      {conflict}
      <div ref={actions} className="flex flex-wrap gap-2">
        <Button id={SAVE_RULE_ID} type="button" onClick={() => { if (!disabled && !conflict) onSave(); }} disabled={!disabled && !isDraftValid(draft)}
          aria-disabled={disabled || !isDraftValid(draft) || Boolean(conflict)}
          aria-describedby={[error ? errorId : null, conflict ? CONFLICT_ID : null].filter(Boolean).join(" ") || undefined}>
          {saving ? "Saving…" : draft.ruleId ? "Save changes" : "Create rule"}
        </Button>
        <Button type="button" variant="ghost" disabled={disabled} onClick={onCancel}>
          Cancel
        </Button>
        {onDelete ? (
          // A delete during a save would race it, so wait for the save to finish.
          <Button type="button" variant="ghost" className="ml-auto text-danger" aria-disabled={disabled} aria-describedby={error ? errorId : undefined} onClick={() => { if (!disabled) onDelete(); }}>
            {deleting ? "Deleting…" : "Delete rule"}
          </Button>
        ) : null}
      </div>
      {error ? <p id={errorId} ref={errorElement} role="alert" className="text-sm text-danger">{error}</p> : null}
    </div>
  );
}
