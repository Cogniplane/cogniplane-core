"use client";

import { useEffect, useState } from "react";

import type {
  PiiEntityType,
  PiiMode,
  PiiProtectionSettings,
  PiiRawRetention
} from "@cogniplane/shared-types";
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
import { PILL_GRAY, PILL_GREEN, SECTION_LABEL } from "../../../lib/ui-tokens";

const CHIP =
  "inline-flex items-center rounded bg-surface-container px-1.5 py-0.5 text-xs text-on-surface-variant";

const MODE_OPTIONS: Array<{ value: PiiMode; label: string; description: string }> = [
  { value: "off", label: "Off", description: "No PII logic is applied." },
  { value: "detect", label: "Detect (async report)", description: "Scan is async. Findings reported to admins only." },
  { value: "block", label: "Block", description: "Scan sync. Reject content when matches are found." },
  { value: "transform", label: "Transform", description: "Scan sync. Redact content before runtime sees it." }
];

const RAW_RETENTION_OPTIONS: Array<{ value: PiiRawRetention; label: string; description: string }> = [
  { value: "never", label: "Never", description: "Raw content is discarded after transform." },
  { value: "admin_only", label: "Admin-only", description: "Encrypted raw copy, admin-restricted access (Phase 3)." },
  { value: "reversible_encrypted", label: "Reversible encrypted", description: "Encrypted raw copy for restore/export (Phase 3)." }
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
  "email",
  "phone",
  "person_name",
  "address",
  "financial",
  "government_id"
];

function CheckboxRow(props: {
  id: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-on-surface" htmlFor={props.id}>
      <input
        id={props.id}
        type="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
        className="size-4 rounded border-outline-variant accent-primary"
      />
      <span>{props.label}</span>
    </label>
  );
}

export function AdminPiiProtectionSection(props: {
  value: PiiProtectionSettings | null;
  busy: boolean;
  onSave: (next: PiiProtectionSettings) => void;
}) {
  const [draft, setDraft] = useState<PiiProtectionSettings | null>(props.value);

  useEffect(() => {
    // Resync the form draft when the saved settings change.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft(props.value);
  }, [props.value]);

  if (!draft) {
    return null;
  }

  const isTransformWithRetention =
    draft.mode === "transform" && draft.rawRetention !== "never";
  const combinationInvalid = draft.enabled && draft.mode === "off";

  const toggleEntity = (entity: PiiEntityType) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const has = prev.detectors.entityTypes.includes(entity);
      const next = has
        ? prev.detectors.entityTypes.filter((e) => e !== entity)
        : [...prev.detectors.entityTypes, entity];
      return { ...prev, detectors: { ...prev.detectors, entityTypes: next } };
    });
  };

  const modeDescription = MODE_OPTIONS.find((m) => m.value === draft.mode)?.description;
  const retentionDescription = RAW_RETENTION_OPTIONS.find((r) => r.value === draft.rawRetention)?.description;

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className={SECTION_LABEL}>Privacy</p>
          <h2 className="text-lg font-semibold text-on-surface">PII protection</h2>
          <p className="mt-1 max-w-prose text-sm text-on-surface-variant">
            Organization-level policy for personally identifiable information in chat prompts,
            uploads, and Microsoft imports.
          </p>
        </div>
        <span className={draft.enabled ? PILL_GREEN : PILL_GRAY}>
          {draft.enabled ? `enabled (${draft.mode})` : "disabled"}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className={CHIP}>organization scoped</span>
        <span className={CHIP}>provider: {draft.provider.type}</span>
        <span className={CHIP}>retention: {draft.rawRetention}</span>
      </div>

      <form
        className="mt-6 flex flex-col gap-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (combinationInvalid) return;
          props.onSave(draft);
        }}
      >
        <CheckboxRow
          id="pii-enabled"
          checked={draft.enabled}
          onChange={(checked) => setDraft({ ...draft, enabled: checked })}
          label="Enable PII protection"
        />

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pii-mode">Mode</Label>
          <Select
            value={draft.mode}
            onValueChange={(value) => setDraft({ ...draft, mode: value as PiiMode })}
          >
            <SelectTrigger id="pii-mode" className="w-full sm:w-80">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODE_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {modeDescription ? (
            <p className="text-xs text-on-surface-faint">{modeDescription}</p>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pii-retention">Raw retention</Label>
          <Select
            value={draft.rawRetention}
            onValueChange={(value) =>
              setDraft({ ...draft, rawRetention: value as PiiRawRetention })
            }
          >
            <SelectTrigger id="pii-retention" className="w-full sm:w-80">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RAW_RETENTION_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {retentionDescription ? (
            <p className="text-xs text-on-surface-faint">{retentionDescription}</p>
          ) : null}
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-semibold text-on-surface">Provider</legend>
          <Label htmlFor="pii-model">Model</Label>
          <Input
            id="pii-model"
            autoComplete="off"
            type="text"
            value={draft.provider.model}
            placeholder="Leave blank to use the system default model"
            onChange={(e) =>
              setDraft({
                ...draft,
                provider: { ...draft.provider, model: e.target.value }
              })
            }
          />
          <p className="text-xs text-on-surface-faint">
            Detection runs against the configured PII model endpoint. In{" "}
            <code className="rounded bg-surface-container px-1 py-0.5 text-[0.7rem]">block</code> and{" "}
            <code className="rounded bg-surface-container px-1 py-0.5 text-[0.7rem]">transform</code> modes, raw content is
            sent to that endpoint for inspection. On Cogniplane Cloud the endpoint is a private, in-VPC model — no
            third-party API and no external query logs. Self-hosted deployments may point it at any OpenAI-compatible
            provider; confirm that provider's data-handling posture before enabling.
          </p>
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-semibold text-on-surface">Scopes</legend>
          <CheckboxRow
            id="pii-scope-chat"
            checked={draft.scopes.chatPrompts}
            onChange={(checked) =>
              setDraft({ ...draft, scopes: { ...draft.scopes, chatPrompts: checked } })
            }
            label="Chat prompts"
          />
          <CheckboxRow
            id="pii-scope-uploads"
            checked={draft.scopes.uploads}
            onChange={(checked) =>
              setDraft({ ...draft, scopes: { ...draft.scopes, uploads: checked } })
            }
            label="Direct uploads"
          />
          <CheckboxRow
            id="pii-scope-microsoft"
            checked={draft.scopes.microsoftImports}
            onChange={(checked) =>
              setDraft({
                ...draft,
                scopes: { ...draft.scopes, microsoftImports: checked }
              })
            }
            label="Microsoft imports"
          />
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-semibold text-on-surface">Detectors</legend>
          <CheckboxRow
            id="pii-rules-first"
            checked={draft.detectors.useRulesFirst}
            onChange={(checked) =>
              setDraft({
                ...draft,
                detectors: { ...draft.detectors, useRulesFirst: checked }
              })
            }
            label="Run rule-based detection before calling the provider"
          />
          <p className="mt-1 text-xs text-on-surface-faint">Entity types:</p>
          <div className="flex flex-col gap-1.5">
            {ALL_ENTITY_TYPES.map((entity) => (
              <CheckboxRow
                key={entity}
                id={`pii-entity-${entity}`}
                checked={draft.detectors.entityTypes.includes(entity)}
                onChange={() => toggleEntity(entity)}
                label={ENTITY_TYPE_LABELS[entity]}
              />
            ))}
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-semibold text-on-surface">Actions</legend>
          <CheckboxRow
            id="pii-report-admins"
            checked={draft.actions.reportToAdmins}
            onChange={(checked) =>
              setDraft({
                ...draft,
                actions: { ...draft.actions, reportToAdmins: checked }
              })
            }
            label="Report findings to admins"
          />
        </fieldset>

        {combinationInvalid ? (
          <p className="text-sm text-danger">
            Cannot enable PII protection with mode set to{" "}
            <code className="rounded bg-surface-container px-1 py-0.5 text-[0.7rem]">off</code>. Choose another mode
            or disable protection.
          </p>
        ) : null}

        {isTransformWithRetention ? (
          <p className="max-w-prose text-sm text-on-surface-variant">
            <strong className="font-semibold text-on-surface">Warning:</strong>{" "}
            <code className="rounded bg-surface-container px-1 py-0.5 text-[0.7rem]">transform</code> with raw retention
            other than <code className="rounded bg-surface-container px-1 py-0.5 text-[0.7rem]">never</code> keeps an
            encrypted copy of the original content. Ensure your compliance posture permits this before enabling.
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={props.busy || combinationInvalid}>
            {props.busy ? "Saving..." : "Save PII settings"}
          </Button>
        </div>
      </form>
    </>
  );
}
