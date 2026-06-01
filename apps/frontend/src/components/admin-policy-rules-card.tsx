"use client";

import { useState } from "react";

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
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import type { PolicyLintWarning, PolicyRule } from "@cogniplane/shared-types";

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
  SEVERITY_LABELS,
  toggleInList,
  TURN_CONTEXT_LABELS,
  type PolicyRuleDraft
} from "./admin-policy-form.logic";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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

const PILL_BASE = "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium";
const PILL_GRAY = `${PILL_BASE} bg-surface-container text-on-surface-variant`;
const PILL_AMBER = `${PILL_BASE} bg-warning-surface text-warning`;
const PILL_GREEN = `${PILL_BASE} bg-success-surface text-success`;
const LIST_ITEM = "rounded-lg border border-outline-variant bg-surface-container-lowest p-3";

type Props = {
  rules: PolicyRule[];
  lintWarnings: PolicyLintWarning[];
  busyKey: string | null;
  onSave: (ruleId: string | null, input: ReturnType<typeof draftToInput>) => Promise<boolean>;
  onDelete: (ruleId: string) => void;
  onReorder: (ruleIds: string[]) => void;
};

const LINT_KIND_LABELS: Record<PolicyLintWarning["kind"], string> = {
  shadowed: "Unreachable",
  duplicate: "Duplicate",
  unknown_condition: "Unknown condition"
};

export function AdminPolicyRulesCard({ rules, lintWarnings, busyKey, onSave, onDelete, onReorder }: Props) {
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
    if (!over || active.id === over.id) return;
    const oldIndex = rules.findIndex((r) => r.ruleId === active.id);
    const newIndex = rules.findIndex((r) => r.ruleId === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = arrayMove(rules, oldIndex, newIndex);
    onReorder(reordered.map((r) => r.ruleId));
  }

  async function handleSave() {
    if (!draft || !isDraftValid(draft)) return;
    const ok = await onSave(draft.ruleId, draftToInput(draft));
    if (ok) setDraft(null);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Policy rules</CardTitle>
        <CardDescription>
          Evaluated top-to-bottom by priority for every agent tool action — the first matching rule
          decides. Whether matching rules actually gate is the tenant-level enforcement mode (set in
          Agent settings); until it&rsquo;s set to enforce, rules only record decisions. Drag a rule
          by its handle to change its priority.
        </CardDescription>
        <div className="pt-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => setDraft(draft ? null : emptyDraft())}
          >
            {draft ? "Cancel" : "New rule"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {draft ? (
          <RuleEditor
            draft={draft}
            setDraft={setDraft}
            onSave={handleSave}
            saving={busyKey === "submit"}
          />
        ) : null}

        {rules.length === 0 ? (
          <p className="text-sm text-on-surface-faint">
            No rules yet. Policy Center is inert until you add one.
          </p>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={rules.map((r) => r.ruleId)} strategy={verticalListSortingStrategy}>
              <ul className="flex flex-col gap-2">
                {rules.map((rule) => (
                  <SortableRuleRow
                    key={rule.ruleId}
                    rule={rule}
                    warnings={warningsByRule.get(rule.ruleId) ?? []}
                    reorderable={reorderable}
                    deleting={busyKey === `delete-${rule.ruleId}`}
                    onEdit={() => setDraft(draftFromRule(rule))}
                    onDelete={() => onDelete(rule.ruleId)}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}
      </CardContent>
    </Card>
  );
}

function SortableRuleRow({
  rule,
  warnings,
  reorderable,
  deleting,
  onEdit,
  onDelete
}: {
  rule: PolicyRule;
  warnings: PolicyLintWarning[];
  reorderable: boolean;
  deleting: boolean;
  onEdit: () => void;
  onDelete: () => void;
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

  return (
    <li ref={setNodeRef} style={style} className={LIST_ITEM}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          {reorderable ? (
            <button
              type="button"
              aria-label={`Reorder ${rule.name}`}
              className="mt-0.5 cursor-grab touch-none rounded px-1 text-on-surface-faint hover:text-on-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary active:cursor-grabbing"
              {...attributes}
              {...listeners}
            >
              ⠿
            </button>
          ) : null}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-on-surface">{rule.name}</span>
              <span className={PILL_GRAY}>{EFFECT_LABELS[rule.effect]}</span>
              {rule.enabled ? null : <span className={PILL_GRAY}>disabled</span>}
              <span className={PILL_GREEN}>priority {rule.priority}</span>
            </div>
            <p className="mt-1 text-xs text-on-surface-faint">
              {describeConditions(rule.conditions)}
            </p>
            {rule.reason ? (
              <p className="mt-1 text-xs text-on-surface-variant">{rule.reason}</p>
            ) : null}
            {warnings.map((warning, i) => (
              <p key={i} className="mt-1 flex items-start gap-1.5 text-xs text-warning">
                <span className={`${PILL_AMBER} shrink-0`}>{LINT_KIND_LABELS[warning.kind]}</span>
                <span>{warning.message}</span>
              </p>
            ))}
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button type="button" variant="ghost" onClick={onEdit}>
            Edit
          </Button>
          <Button type="button" variant="ghost" disabled={deleting} onClick={onDelete}>
            Delete
          </Button>
        </div>
      </div>
    </li>
  );
}

function RuleEditor({
  draft,
  setDraft,
  onSave,
  saving
}: {
  draft: PolicyRuleDraft;
  setDraft: (next: PolicyRuleDraft | null) => void;
  onSave: () => void;
  saving: boolean;
}) {
  const update = (patch: Partial<PolicyRuleDraft>) => setDraft({ ...draft, ...patch });

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

      <div className="flex flex-col gap-1.5">
        <Label>Severities</Label>
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
          Leave all unchecked to match any severity. All condition dimensions are AND-ed together;
          within a dimension the checked values are OR-ed.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Turn context</Label>
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
          Unchecked → any. Use &ldquo;Scheduled&rdquo; to gate unattended runs more strictly.
        </p>
      </div>

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
        <Button type="button" variant="ghost" onClick={() => setDraft(null)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
