"use client";

import { useId, useMemo, useRef, useState } from "react";

import { createPortal } from "react-dom";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../ui/dialog";
import type { AdminIntegrationView, IntegrationConfigField } from "@cogniplane/shared-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PILL_GREEN } from "../../../lib/ui-tokens";

const PASSWORD_PLACEHOLDER = "••••••••";

type Props = {
  integration: AdminIntegrationView;
  busy: boolean;
  operation?: "toggle" | "save" | "clear";
  footerTarget?: HTMLElement | null;
  error: string | null;
  errorOperation?: "toggle" | "save" | "clear";
  onSave: (config: Record<string, string>) => Promise<boolean | void>;
  onClear: () => Promise<boolean | void>;
};

/** Form values from the saved summary. Secrets are never echoed back, so passwords start empty. */
function savedValuesFor(fields: readonly IntegrationConfigField[], summary: Record<string, string>): Record<string, string> {
  return Object.fromEntries(fields.map((f) => [f.key, f.type === "password" ? "" : summary[f.key] || ""]));
}

export function AdminIntegrationPaneOauthApp(props: Props) {
  const { integration, busy, operation, footerTarget, error, errorOperation, onSave, onClear } = props;
  const formId = useId();
  const [confirmClear, setConfirmClear] = useState(false);
  const [localPending, setLocalPending] = useState<"save" | "clear" | null>(null);
  const pendingRef = useRef(false);
  const saveButton = useRef<HTMLButtonElement>(null);
  const clearButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const locked = busy || localPending !== null;
  const activeOperation = localPending ?? operation ?? (busy ? "save" : undefined);
  const fields = useMemo(() => integration.configFields ?? [], [integration.configFields]);
  const savedValues = savedValuesFor(fields, integration.configSummary);
  const savedSignature = JSON.stringify([integration.id, integration.updatedAt, integration.hasConfig, fields, integration.configSummary]);
  const [draft, setDraft] = useState(() => ({ integrationId: integration.id, savedSignature, baseline: savedValues, values: savedValues }));
  const { values } = draft;
  const dirty = JSON.stringify(values) !== JSON.stringify(draft.baseline);
  const savedChanged = draft.savedSignature !== savedSignature;

  // Adopt refreshed values only when there is no unsent draft or active write.
  if (draft.integrationId !== integration.id || (savedChanged && !dirty && !locked)) {
    setDraft({ integrationId: integration.id, savedSignature, baseline: savedValues, values: savedValues });
  }
  const reloadSaved = () => setDraft({ integrationId: integration.id, savedSignature, baseline: savedValues, values: savedValues });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pendingRef.current || busy) return;
    pendingRef.current = true;
    setLocalPending("save");
    if (e.currentTarget.contains(document.activeElement)) saveButton.current?.focus();
    try {
      const success = await onSave(values);
      if (success !== false) {
        const confirmed = Object.fromEntries(fields.map(field => [field.key, field.type === "password" ? "" : values[field.key] ?? ""]));
        setDraft({ integrationId: integration.id, savedSignature, baseline: confirmed, values: confirmed });
      }
    } finally { pendingRef.current = false; setLocalPending(null); }
  };

  const handleClear = async () => {
    if (pendingRef.current || busy) return;
    pendingRef.current = true;
    setLocalPending("clear");
    try {
      const success = await onClear();
      if (success !== false) {
        const cleared = savedValuesFor(fields, {});
        setDraft({ integrationId: integration.id, savedSignature, baseline: cleared, values: cleared });
        setConfirmClear(false);
      }
    } finally {
      pendingRef.current = false;
      setLocalPending(null);
    }
  };

  const decisions = <div className="flex flex-col gap-2 border-t border-outline-variant pt-3">
    {error && !confirmClear ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
    <div className="flex flex-wrap items-center gap-2">
      <Button ref={saveButton} type="submit" form={formId} aria-disabled={locked} className="aria-disabled:opacity-50"
        onClick={event => { if (locked) event.preventDefault(); }}>
        {activeOperation === "save" ? "Saving configuration..." : integration.hasConfig ? "Update configuration" : "Save configuration"}
      </Button>
      {integration.hasConfig ? <Button ref={clearButton} type="button" variant="outline" aria-disabled={locked} className="aria-disabled:opacity-50"
        onClick={() => { if (!locked) setConfirmClear(true); }}>Clear configuration</Button> : null}
    </div>
    {locked ? <p role="status" className="text-xs text-on-surface-variant">{activeOperation === "clear" ? "Clearing configuration. Keep this dialog open." : "Saving changes. Keep this dialog open."}</p> : null}
  </div>;

  return <>
    <form id={formId}
      onSubmit={handleSubmit}
      className="flex flex-col gap-3 border-t border-outline-variant pt-3"
    >
      <h4 className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
        OAuth application
      </h4>
      {!integration.hasConfig ? (
        <p className="text-sm text-on-surface-faint">
          {integration.setupHelp ??
            "Provide the credentials to allow users to connect their accounts."}
        </p>
      ) : (
        <p className="text-sm text-on-surface-variant">
          <span className={PILL_GREEN}>Configured</span>{" "}
          <span>
            Saved
            {integration.updatedAt
              ? ` ${new Date(integration.updatedAt).toLocaleString()}`
              : ""}
            {integration.updatedBy ? ` by ${integration.updatedBy}` : ""}.
          </span>
        </p>
      )}

      <p className="text-xs text-on-surface-variant">Application configuration does not show whether a member has connected their account.</p>
      {integration.hasConfig ? <p className="text-xs text-on-surface-variant">Leave password fields empty to keep their saved values.</p> : null}
      {savedChanged && dirty ? <div role="status" className="space-y-2 text-sm text-on-surface-variant">
        <p>Saved configuration changed. Your unsaved entries are kept. Reload saved values to discard them.</p>
        <Button type="button" variant="outline" className="h-auto min-h-9 max-w-full whitespace-normal" disabled={locked} onClick={reloadSaved}>Reload saved values and discard my entries</Button>
      </div> : null}
      {fields.map((field) => {
        const isPassword = field.type === "password";
        const placeholder = isPassword
          ? integration.configSummary[field.key] !== undefined ||
            (integration.hasConfig && !values[field.key])
            ? PASSWORD_PLACEHOLDER
            : ""
          : "";
        const inputId = `integration-${field.key}`;
        return (
          <div key={field.key} className="flex flex-col gap-1.5">
            <Label htmlFor={inputId}>
              {field.label}
              {field.required ? " *" : ""}
            </Label>
            <Input
              id={inputId}
              type={isPassword ? "password" : field.type === "url" ? "url" : "text"}
              value={values[field.key] ?? ""}
              placeholder={placeholder}
              onChange={(e) =>
                setDraft(prev => ({ ...prev, values: { ...prev.values, [field.key]: e.target.value } }))
              }
              disabled={locked}
              autoComplete={isPassword ? "new-password" : "off"}
            />
            {field.helpText ? (
              <small className="text-xs text-on-surface-faint">{field.helpText}</small>
            ) : null}
          </div>
        );
      })}

    </form>
    {footerTarget ? createPortal(decisions, footerTarget) : decisions}
    <Dialog open={confirmClear} onOpenChange={open => { if (!pendingRef.current && !busy) setConfirmClear(open); }}>
      <DialogContent showCloseButton={!locked} className="sm:max-w-[520px]"
        onOpenAutoFocus={event => { event.preventDefault(); cancelButton.current?.focus(); }}
        onCloseAutoFocus={event => { event.preventDefault(); (integration.hasConfig ? clearButton : saveButton).current?.focus(); }}
        onEscapeKeyDown={event => { if (locked) event.preventDefault(); }}
        onInteractOutside={event => { if (locked) event.preventDefault(); }}
        footer={<div className="flex shrink-0 flex-col gap-2 border-t border-outline-variant pt-3">
          {error && errorOperation !== "save" ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button ref={cancelButton} type="button" variant="outline" aria-disabled={locked} className="aria-disabled:opacity-50" onClick={() => { if (!locked) setConfirmClear(false); }}>Keep configuration</Button>
            <Button type="button" variant="destructive" className="h-auto min-h-9 whitespace-normal" aria-disabled={locked} onClick={() => void handleClear()}>
              {activeOperation === "clear" ? "Clearing configuration..." : `Clear ${integration.name} configuration`}
            </Button>
          </div>
        </div>}>
        <DialogHeader>
          <DialogTitle>Clear {integration.name} configuration?</DialogTitle>
          <DialogDescription>This removes the organization's saved application settings for {integration.name} and turns off its read and write access.</DialogDescription>
        </DialogHeader>
        <p className="text-sm text-on-surface-variant">Organization execution workspaces reset so the access change takes effect. Recreate any workspace files you still need.</p>
      </DialogContent>
    </Dialog>
  </>;
}
