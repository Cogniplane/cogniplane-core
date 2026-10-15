"use client";

import { useEffect, useMemo, useState } from "react";

import type { AdminIntegrationView, IntegrationConfigField } from "@cogniplane/shared-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PILL_GREEN } from "../../../lib/ui-tokens";

const PASSWORD_PLACEHOLDER = "••••••••";

type Props = {
  integration: AdminIntegrationView;
  busy: boolean;
  error: string | null;
  onSave: (config: Record<string, string>) => Promise<void>;
  onClear: () => Promise<void>;
};

/** Form values from the saved summary. Secrets are never echoed back, so passwords start empty. */
function savedValuesFor(fields: readonly IntegrationConfigField[], summary: Record<string, string>): Record<string, string> {
  return Object.fromEntries(fields.map((f) => [f.key, f.type === "password" ? "" : summary[f.key] || ""]));
}

export function AdminIntegrationPaneOauthApp(props: Props) {
  const { integration, busy, error, onSave, onClear } = props;
  const fields = useMemo(() => integration.configFields ?? [], [integration.configFields]);
  const [values, setValues] = useState(() => savedValuesFor(fields, integration.configSummary));

  useEffect(() => {
    // Resync the form draft when the integration row changes (e.g., after save).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setValues(savedValuesFor(fields, integration.configSummary));
  }, [integration.id, integration.updatedAt, integration.configSummary, fields]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await onSave(values);
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-3 rounded-lg border border-outline-variant bg-surface-container-low p-3"
    >
      <h4 className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
        OAuth application
      </h4>
      {!integration.hasConfig ? (
        <p className="text-sm text-on-surface-faint">
          Provide the credentials from your Microsoft Entra app registration to allow users to
          connect their accounts.
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
                setValues((prev) => ({ ...prev, [field.key]: e.target.value }))
              }
              disabled={busy}
              autoComplete={isPassword ? "new-password" : "off"}
            />
            {field.helpText ? (
              <small className="text-xs text-on-surface-faint">{field.helpText}</small>
            ) : null}
          </div>
        );
      })}

      {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={busy}>
          {busy
            ? "Saving..."
            : integration.hasConfig
              ? "Update configuration"
              : "Save configuration"}
        </Button>
        {integration.hasConfig ? (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void onClear()}
          >
            Clear configuration
          </Button>
        ) : null}
      </div>
    </form>
  );
}
