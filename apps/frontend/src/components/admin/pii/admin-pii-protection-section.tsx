"use client";

import { useEffect, useRef, useState } from "react";

import type { PiiEntityType, PiiMode, PiiProtectionSettings, PiiRawRetention } from "@cogniplane/shared-types";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConfirmLeave } from "@/hooks/use-confirm-leave";
import { DisclosureRow, OverviewRow } from "../overview-row";
import { SaveBar } from "../save-bar";

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

const SCOPE_LABELS = { chatPrompts: "Chat prompts", uploads: "Direct uploads", microsoftImports: "Microsoft imports" } as const;

function CheckboxRow(props: { id: string; checked: boolean; onChange: (next: boolean) => void; label: string }) {
  return (
    <label className="flex items-center gap-2 text-sm text-on-surface" htmlFor={props.id}>
      <input
        id={props.id}
        type="checkbox"
        checked={props.checked}
        onChange={(event) => props.onChange(event.target.checked)}
        className="size-4 rounded border-outline-variant accent-primary"
      />
      <span>{props.label}</span>
    </label>
  );
}

export function AdminPiiProtectionSection(props: {
  value: PiiProtectionSettings | null;
  busy: boolean;
  error: string | null;
  savedMessage: string | null;
  onSave: (next: PiiProtectionSettings) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<PiiProtectionSettings | null>(props.value);
  const [editing, setEditing] = useState(false);
  // Messages from the shared hook outlive this form's actions, so show them only for the last save here.
  const [lastSave, setLastSave] = useState<"saved" | "failed" | null>(null);
  // The save buttons go away when the draft is clean, so focus moves to the status.
  const statusRef = useRef<HTMLDivElement>(null);
  useConfirmLeave(editing && JSON.stringify(draft) !== JSON.stringify(props.value));

  useEffect(() => {
    if (!editing) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDraft(props.value);
    } else if (draft && props.value && JSON.stringify(draft) === JSON.stringify(props.value)) {
      // A successful save is complete when the server snapshot catches up.
      setEditing(false);
    }
  }, [props.value, editing, draft]);

  if (!draft || !props.value) return null;

  const persistedMode = effectiveMode(props.value);
  const selectedMode = effectiveMode(draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(props.value);
  const modeDescription = MODE_OPTIONS.find((option) => option.value === selectedMode)?.description;
  const retentionDescription = RETENTION_OPTIONS.find((option) => option.value === draft.rawRetention)?.description;

  function changeDraft(next: PiiProtectionSettings) {
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
    if (!draft || !props.value) return;
    // The server trims the model name. Trim it here too, so the saved value matches the draft.
    const next = { ...draft, provider: { ...draft.provider, model: draft.provider.model.trim() } };
    setDraft(next);
    const ok = await props.onSave(next);
    setLastSave(ok ? "saved" : "failed");
    if (ok) statusRef.current?.focus();
  }

  function cancel() {
    setDraft(props.value);
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

  const scopes = (Object.keys(SCOPE_LABELS) as Array<keyof typeof SCOPE_LABELS>).filter((scope) => draft.scopes[scope]);
  const scopeLine = scopes.length === 0
    ? "No chat prompts, uploads, or imports are scanned."
    : `${scopes.map((scope) => SCOPE_LABELS[scope]).join(", ").replace(/, ([^,]*)$/, " and $1")}.`;
  const retentionWarning = selectedMode === "transform" && draft.rawRetention !== "never"
    ? `The agent receives redacted chat prompts. Original matched values remain stored ${draft.rawRetention === "admin_only" ? "readable by admins" : "encrypted"} in findings.`
    : draft.rawRetention === "admin_only" ? "Matched values remain readable in admin findings." : null;
  const entityCount = draft.detectors.entityTypes.length;

  return (
    <form onSubmit={async (event) => {
      event.preventDefault();
      if (!dirty || props.busy) return;
      await save();
    }}>
      <h2 className="sr-only">PII protection</h2>
      <div className="divide-y divide-outline-variant border-t border-outline-variant">
        <OverviewRow
          title="Protection mode"
          status={<>
            {modeDescription}
            {selectedMode !== persistedMode ? <span className="text-warning"> Saved mode: {MODE_OPTIONS.find((option) => option.value === persistedMode)?.label}.</span> : null}
          </>}
        >
          <Select value={selectedMode} onValueChange={(value) => chooseMode(value as PiiMode)}>
            <SelectTrigger aria-label="Protection mode" size="sm" className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              {MODE_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </OverviewRow>

        <OverviewRow title="Where to scan" status={scopeLine}>
          <fieldset className="flex flex-wrap gap-x-4 gap-y-2">
            <legend className="sr-only">Where to scan</legend>
            <CheckboxRow id="pii-scope-chat" checked={draft.scopes.chatPrompts} onChange={(checked) => changeDraft({ ...draft, scopes: { ...draft.scopes, chatPrompts: checked } })} label={SCOPE_LABELS.chatPrompts} />
            <CheckboxRow id="pii-scope-uploads" checked={draft.scopes.uploads} onChange={(checked) => changeDraft({ ...draft, scopes: { ...draft.scopes, uploads: checked } })} label={SCOPE_LABELS.uploads} />
            <CheckboxRow id="pii-scope-microsoft" checked={draft.scopes.microsoftImports} onChange={(checked) => changeDraft({ ...draft, scopes: { ...draft.scopes, microsoftImports: checked } })} label={SCOPE_LABELS.microsoftImports} />
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
            <SelectTrigger aria-label="Matched values" size="sm" className="w-56"><SelectValue /></SelectTrigger>
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
        busy={props.busy}
        status={props.busy ? null : dirty ? <span className="text-on-surface-variant">Unsaved changes</span> : lastSave === "saved" ? <span className="text-success">{props.savedMessage ?? "Saved."}</span> : null}
        error={lastSave === "failed" ? props.error : null}
        submitLabel="Save changes"
        busyLabel="Saving..."
        onCancel={cancel}
        statusRef={statusRef}
      />
    </form>
  );
}
