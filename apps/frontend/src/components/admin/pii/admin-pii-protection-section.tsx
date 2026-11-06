"use client";

import { useRef, useState } from "react";

import type { PiiEntityType, PiiMode, PiiPolicyHealth, PiiProtectionSettings, PiiRawRetention } from "@cogniplane/shared-types";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { PiiSaveResult } from "@/hooks/use-admin-organization-data";
import { useConfirmLeave } from "@/hooks/use-confirm-leave";
import { piiScopeLabel } from "@/lib/pii-scope-labels";
import { DisclosureRow, OverviewRow } from "../overview-row";
import { SaveBar } from "../save-bar";
import { PiiPolicyHealthNotice } from "./pii-policy-health-notice";

const MODE_OPTIONS: Array<{ value: PiiMode; label: string; description: string }> = [
  { value: "off", label: "Off", description: "No PII scans run." },
  { value: "detect", label: "Detect", description: "Scan in the background and report findings to admins." },
  { value: "block", label: "Block", description: "Check content before use and reject it when a match is found." },
  { value: "transform", label: "Transform", description: "Redact matches in chat prompts before the agent receives them. Uploads and imports are only reported." }
];

const RETENTION_OPTIONS: Array<{ value: PiiRawRetention; label: string; description: string }> = [
  { value: "never", label: "Do not keep matched values", description: "Stored findings omit the matched text." },
  { value: "admin_only", label: "Keep values for admins", description: "Stored findings include matched text. Admin access is required to view it." },
  { value: "reversible_encrypted", label: "Keep encrypted values", description: "Matched text is encrypted in findings. A server-side PII retention key is required for scans to succeed." }
];

const ENTITY_TYPE_LABELS: Record<PiiEntityType, string> = {
  email: "Email",
  phone: "Phone",
  person_name: "Person name",
  address: "Address",
  financial: "Financial",
  government_id: "Government ID"
};

const ALL_ENTITY_TYPES: PiiEntityType[] = [
  "email", "phone", "person_name", "address", "financial", "government_id"
];

function effectiveMode(settings: PiiProtectionSettings): PiiMode {
  return settings.enabled ? settings.mode : "off";
}

// Core scopes. Every other key in `scopes` is an import scope that the server
// lets an admin configure; a registered label names it.
const CORE_SCOPES = [
  { key: "chatPrompts", id: "pii-scope-chat", label: "Chat prompts" },
  { key: "uploads", id: "pii-scope-uploads", label: "Direct uploads" }
] as const;

function scopeRows(scopes: PiiProtectionSettings["scopes"]): Array<{ key: string; id: string; label: string }> {
  const importKeys = Object.keys(scopes).filter((key) => !CORE_SCOPES.some((scope) => scope.key === key));
  return [
    ...CORE_SCOPES,
    ...importKeys.map((key) => ({ key, id: `pii-scope-${key}`, label: piiScopeLabel(key) }))
  ];
}

function CheckboxRow(props: { id: string; checked: boolean; onChange: (next: boolean) => void; label: string }) {
  return (
    <label className="flex min-h-10 min-w-0 items-center gap-2 text-sm text-on-surface sm:min-h-6" htmlFor={props.id}>
      <input
        id={props.id}
        type="checkbox"
        checked={props.checked}
        onChange={(event) => props.onChange(event.target.checked)}
        className="size-4 shrink-0 rounded border-input accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      />
      <span>{props.label}</span>
    </label>
  );
}

export function AdminPiiProtectionSection(props: {
  value: PiiProtectionSettings | null;
  /** The revision of `value`. Undefined when the server is older than revisions. */
  revision?: number;
  /**
   * What the server did with the stored policy. When it is not ok, `value`
   * has safe values that are not stored, so the form asks for a save also
   * when the draft has no change. Undefined when the server sends none.
   */
  health?: PiiPolicyHealth;
  busy: boolean;
  error: string | null;
  /** True when the last save failed because another session saved first. */
  conflict?: boolean;
  savedMessage: string | null;
  onSave: (next: PiiProtectionSettings, expectedRevision?: number) => Promise<PiiSaveResult>;
}) {
  const [draft, setDraft] = useState<PiiProtectionSettings | null>(props.value);
  // The revision that the draft is based on. A refresh during an edit does not
  // change it, so a save after another session's save is refused.
  const [draftRevision, setDraftRevision] = useState(props.revision);
  const [snapshot, setSnapshot] = useState({ value: props.value, revision: props.revision });
  const [editing, setEditing] = useState(false);
  // Messages from the shared hook outlive this form's actions, so show them only for the last save here.
  const [lastSave, setLastSave] = useState<"saved" | "failed" | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const editVersion = useRef(0);
  // Move focus to the result only while this save still owns it.
  const statusRef = useRef<HTMLDivElement>(null);
  useConfirmLeave(editing && JSON.stringify(draft) !== JSON.stringify(props.value));

  // Sync before commit. A deferred effect can overwrite an edit made just after a refresh.
  if (snapshot.value !== props.value || snapshot.revision !== props.revision) {
    setSnapshot({ value: props.value, revision: props.revision });
    if (!editing) {
      setDraft(props.value);
      setDraftRevision(props.revision);
    }
  }
  if (editing && draft && props.value && JSON.stringify(draft) === JSON.stringify(props.value)) {
    // A successful save is complete when the server snapshot catches up.
    setEditing(false);
    setDraft(props.value);
    setDraftRevision(props.revision);
  }

  if (!draft || !props.value) return null;

  const persistedMode = effectiveMode(props.value);
  const selectedMode = effectiveMode(draft);
  const changed = JSON.stringify(draft) !== JSON.stringify(props.value);
  // The shown values are not the stored policy. A save stores them, and that repairs the policy.
  // A repair save that succeeded is complete, also when the refresh with the
  // new health has not arrived (the draft already has the saved revision).
  const repairSaved = lastSave === "saved" && draftRevision !== props.revision;
  const repairNeeded = props.health !== undefined && props.health.state !== "ok" && !repairSaved;
  const dirty = changed || repairNeeded;
  const conflicted = lastSave === "failed" && props.conflict === true;
  const modeDescription = MODE_OPTIONS.find((option) => option.value === selectedMode)?.description;
  const retentionDescription = RETENTION_OPTIONS.find((option) => option.value === draft.rawRetention)?.description;

  function changeDraft(next: PiiProtectionSettings) {
    editVersion.current++;
    setDraft(next);
    setEditing(true);
    setLastSave(null);
  }

  function chooseMode(mode: PiiMode) {
    if (!draft || !props.value) return;
    // A legacy policy saves Off as enabled=false with another mode. Picking Off again restores it exactly.
    if (mode === "off" && !props.value.enabled) changeDraft({ ...draft, enabled: false, mode: props.value.mode });
    else changeDraft({ ...draft, enabled: mode !== "off", mode });
  }

  async function save() {
    if (!draft || !props.value || props.busy || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    const submittedEdit = editVersion.current;
    const focusOwner = document.activeElement;
    let focusMoved = false;
    const trackFocus = (event: FocusEvent) => {
      if (event.target !== focusOwner && event.target !== document.body) focusMoved = true;
    };
    document.addEventListener("focusin", trackFocus);
    try {
      // The server trims the model name. Keep the submitted draft consistent.
      const next = { ...draft, provider: { ...draft.provider, model: draft.provider.model.trim() } };
      setDraft(next);
      const result = await props.onSave(next, draftRevision);
      const laterEdit = editVersion.current !== submittedEdit;
      setLastSave(result.ok && laterEdit ? null : result.ok ? "saved" : "failed");
      if (!result.ok) return;
      // Later edits use the revision returned by this save, even if its refresh fails.
      if (result.revision !== undefined) setDraftRevision(result.revision);
      if (!laterEdit && !focusMoved && (document.activeElement === focusOwner || document.activeElement === document.body)) {
        statusRef.current?.focus();
      }
    } finally {
      document.removeEventListener("focusin", trackFocus);
      savingRef.current = false;
      setSaving(false);
    }
  }

  // After a conflict, the save reads the settings again, so this button
  // ("Reload settings") shows the current settings and their revision.
  function cancel() {
    setDraft(props.value);
    setDraftRevision(props.revision);
    setEditing(false);
    setLastSave(null);
    statusRef.current?.focus();
  }

  function toggleEntity(entity: PiiEntityType) {
    if (!draft) return;
    const current = draft.detectors.entityTypes;
    const entityTypes = current.includes(entity)
      ? current.filter((item) => item !== entity)
      : [...current, entity];
    changeDraft({ ...draft, detectors: { ...draft.detectors, entityTypes } });
  }

  const scopes = scopeRows(draft.scopes);
  const scanned = scopes.filter((scope) => draft.scopes[scope.key]);
  const scopeLine = scanned.length === 0
    ? "No chat prompts, uploads, or imports are scanned."
    : `${scanned.map((scope) => scope.label).join(", ").replace(/, ([^,]*)$/, " and $1")}.`;
  const retentionWarning = selectedMode === "transform" && draft.rawRetention !== "never"
    ? `The agent receives redacted chat prompts. Original matched values remain stored ${draft.rawRetention === "admin_only" ? "readable by admins" : "encrypted"} in findings.`
    : draft.rawRetention === "admin_only" ? "Matched values remain readable in admin findings." : null;
  const entityCount = draft.detectors.entityTypes.length;

  return (
    <form className="[overflow-wrap:anywhere]" onSubmit={async (event) => {
      event.preventDefault();
      if (!dirty || props.busy || savingRef.current) return;
      await save();
    }}>
      <h2 className="sr-only">PII protection</h2>
      {repairNeeded ? (
        <div className="pb-4">
          <PiiPolicyHealthNotice health={props.health} action="Check the values below and save them." />
        </div>
      ) : null}
      <div className="divide-y divide-outline-variant border-t border-outline-variant">
        <OverviewRow
          title="Protection mode"
          status={<>
            {modeDescription}
            {selectedMode !== persistedMode && !repairNeeded ? <span className="text-warning"> Saved mode: {MODE_OPTIONS.find((option) => option.value === persistedMode)?.label}.</span> : null}
          </>}
        >
          <Select value={selectedMode} onValueChange={(value) => chooseMode(value as PiiMode)}>
            <SelectTrigger aria-label="Protection mode" size="sm" className="w-40 data-[size=sm]:h-10 sm:data-[size=sm]:h-8"><SelectValue /></SelectTrigger>
            <SelectContent>
              {MODE_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </OverviewRow>

        <OverviewRow title="Where to scan" status={scopeLine}>
          <fieldset className="flex flex-wrap gap-x-4 gap-y-2">
            <legend className="sr-only">Where to scan</legend>
            {scopes.map((scope) => (
              <CheckboxRow key={scope.key} id={scope.id} checked={draft.scopes[scope.key] === true} onChange={(checked) => changeDraft({ ...draft, scopes: { ...draft.scopes, [scope.key]: checked } })} label={scope.label} />
            ))}
          </fieldset>
        </OverviewRow>

        <OverviewRow
          title="Matched values"
          status={<>
            {retentionDescription}
            {retentionWarning ? <span className="block text-warning">{retentionWarning}</span> : null}
          </>}
        >
          <Select value={draft.rawRetention} onValueChange={(value) => changeDraft({ ...draft, rawRetention: value as PiiRawRetention })}>
            <SelectTrigger aria-label="Matched values" size="sm" className="w-64 max-w-full data-[size=sm]:h-10 sm:data-[size=sm]:h-8"><SelectValue /></SelectTrigger>
            <SelectContent>
              {RETENTION_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </OverviewRow>

        <DisclosureRow
          title="Detection"
          action="Edit detection"
          status={`Looks for ${entityCount === ALL_ENTITY_TYPES.length ? "all" : `${entityCount} of ${ALL_ENTITY_TYPES.length}`} personal data types. Model: ${draft.provider.model.trim() || "deployment default"}.`}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pii-model">PII detection model</Label>
            <Input id="pii-model" autoComplete="off" className="sm:w-96" value={draft.provider.model} placeholder="Use the deployment default" onChange={(event) => changeDraft({ ...draft, provider: { ...draft.provider, model: event.target.value } })} />
            <p className="text-sm text-on-surface-variant">The deployment sets the endpoint. This field picks a model on that endpoint.</p>
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-semibold text-on-surface">Personal data types</legend>
            <p className="text-sm text-on-surface-variant">
              Pattern rules find emails, phone numbers, US Social Security numbers, and card numbers. The detection
              model finds all checked types when the deployment has one. Without it, Detect uses the rules only, and
              Block and Transform cannot run.
            </p>
            <div className="grid gap-2 sm:grid-cols-3">
              {ALL_ENTITY_TYPES.map((entity) => <CheckboxRow key={entity} id={`pii-entity-${entity}`} checked={draft.detectors.entityTypes.includes(entity)} onChange={() => toggleEntity(entity)} label={ENTITY_TYPE_LABELS[entity]} />)}
            </div>
          </fieldset>
        </DisclosureRow>
      </div>

      <SaveBar
        dirty={dirty}
        keepFeedbackVisible
        busy={props.busy || saving}
        // After a save, the health stays old until the refresh succeeds, so the saved message comes first.
        status={props.busy || saving ? null
          : changed ? <span className="text-on-surface-variant">Unsaved changes</span>
          : lastSave === "saved" ? <span className="text-success">{props.savedMessage ?? "Saved."}</span>
          : repairNeeded ? <span className="text-on-surface-variant">Save to repair the policy.</span> : null}
        error={lastSave === "failed" ? props.error : null}
        cancelLabel={conflicted ? "Reload settings" : undefined}
        submitLabel={changed ? "Save changes" : "Save policy"}
        busyLabel="Saving..."
        // A repair with no change has nothing to discard, but after a conflict it must reload.
        onCancel={changed || conflicted ? cancel : undefined}
        statusRef={statusRef}
      />
    </form>
  );
}
