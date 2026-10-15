"use client";

import { useState, type ReactNode } from "react";
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
  describeConditions,
  EFFECT_LABELS,
  emptyDraft,
  isDraftValid,
  reorderedRuleIds,
  SEVERITY_LABELS,
  toggleInList,
  TURN_CONTEXT_LABELS,
  type PolicyRuleDraft
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
  onSave: (ruleId: string | null, input: ReturnType<typeof draftToInput>) => Promise<boolean>;
  onDelete: (ruleId: string) => void;
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

export function AdminPolicyRulesCard({ rules, lintWarnings, busyKey, onSave, onDelete, onReorder, evidence, children }: Props) {
  const [draft, setDraft] = useState<PolicyRuleDraft | null>(null);

  // Group lint warnings by the rule they're about so each row can show its own.
  const warningsByRule = new Map<string, PolicyLintWarning[]>();
  for (const warning of lintWarnings) {
    const list = warningsByRule.get(warning.ruleId) ?? [];
    list.push(warning);
    warningsByRule.set(warning.ruleId, list);
  }

  // Drag-to-reorder is disabled while editing (the draft form changes the
  // layout) and while a reorder is in flight.
  const reorderable = !draft && busyKey !== "reorder" && rules.length > 1;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    const ruleIds = over ? reorderedRuleIds(rules, active.id, over.id) : null;
    if (ruleIds) onReorder(ruleIds);
  }

  // Closing an editor removes the focused control, so move focus to the button that opened it.
  function closeEditor(focusId: string) {
    setDraft(null);
    requestAnimationFrame(() => document.getElementById(focusId)?.focus());
  }

  async function handleSave() {
    if (!draft || !isDraftValid(draft)) return;
    const ok = await onSave(draft.ruleId, draftToInput(draft));
    if (ok) closeEditor(draft.ruleId ? editButtonId(draft.ruleId) : NEW_RULE_ID);
  }

  const creating = draft !== null && draft.ruleId === null;
  const saving = busyKey === "submit";

  return (
    <section aria-labelledby="policy-rules-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="policy-rules-title" className="text-lg font-semibold text-on-surface">Rules</h2>
        {/* An open editor has unsaved edits, so the button cancels it before it starts a new rule. */}
        <Button id={NEW_RULE_ID} type="button" variant="outline" size="sm" aria-expanded={creating} onClick={() => setDraft(draft ? null : emptyDraft())}>
          {draft ? "Cancel" : "New rule"}
        </Button>
      </div>
      <p className="mt-1 text-sm text-on-surface-variant">
        The first matching rule decides. Drag the handle to change the order. A tool call that matches no rule is allowed.
      </p>
      {creating && draft ? <div className="mt-4"><RuleEditor
            draft={draft}
            onChange={setDraft}
            onCancel={() => closeEditor(NEW_RULE_ID)}
            onSave={handleSave}
            saving={saving}
          /></div> : null}

      <div className="mt-3 border-t border-outline-variant">
        {rules.length === 0 ? (
          <p className="py-4 text-sm text-on-surface-variant">No rules. Every tool call is allowed.</p>
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
                    editDisabled={draft !== null && draft.ruleId !== rule.ruleId}
                    onEdit={() => draft?.ruleId === rule.ruleId ? closeEditor(editButtonId(rule.ruleId)) : setDraft(draftFromRule(rule))}
                  >
                    {draft?.ruleId === rule.ruleId ? <RuleEditor
            draft={draft}
            onChange={setDraft}
            onCancel={() => closeEditor(editButtonId(rule.ruleId))}
            onSave={handleSave}
            saving={saving}
            onDelete={() => { onDelete(rule.ruleId); closeEditor(NEW_RULE_ID); }}
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
const editButtonId = (ruleId: string) => `policy-edit-${ruleId}`;

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
      <div className="min-w-0 flex-1">
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
  onDelete
}: {
  draft: PolicyRuleDraft;
  onChange: (next: PolicyRuleDraft) => void;
  onCancel: () => void;
  onSave: () => void;
  saving: boolean;
  onDelete?: () => void;
}) {
  const update = (patch: Partial<PolicyRuleDraft>) => onChange({ ...draft, ...patch });

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-outline bg-surface-container-low p-4">
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

      <div className="flex gap-2">
        <Button type="button" onClick={onSave} disabled={saving || !isDraftValid(draft)}>
          {saving ? "Saving…" : draft.ruleId ? "Save changes" : "Create rule"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        {onDelete ? (
          // A delete during a save would race it, so wait for the save to finish.
          <Button type="button" variant="ghost" className="ml-auto text-danger" disabled={saving} onClick={onDelete}>
            Delete rule
          </Button>
        ) : null}
      </div>
    </div>
  );
}
