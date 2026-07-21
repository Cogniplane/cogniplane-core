"use client";

import { useState } from "react";

import type { AdminProviderStatus, ModelProvider, TenantDetails } from "@cogniplane/shared-types";
import { MODEL_PROVIDERS, MODEL_PROVIDER_META } from "@cogniplane/shared-types";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CHIP, PILL_BLUE, PILL_GRAY, PILL_GREEN, SECTION_LABEL } from "../../lib/ui-tokens";

type KeySource = AdminProviderStatus["keySource"];

function keySourcePill(source: KeySource) {
  switch (source) {
    case "tenant":
      return <span className={PILL_GREEN}>organization key</span>;
    case "platform":
      return <span className={PILL_BLUE}>platform key</span>;
    default:
      return <span className={PILL_GRAY}>no key</span>;
  }
}

type ApiKeyFormProps = {
  inputId: string;
  label: string;
  description: string;
  /** Where the provider's effective key comes from (tenant wins). */
  keySource: KeySource;
  /** Whether an org-level key is stored (the only kind this form can remove). */
  tenantKeyConfigured: boolean;
  busyKey: string;
  currentBusyKey: string | null;
  successMessage: string | null;
  placeholderConfigured: string;
  placeholderUnconfigured: string;
  onSave: (apiKey: string) => void;
  onRemove: () => void;
};

function ApiKeyForm(props: ApiKeyFormProps) {
  const [value, setValue] = useState("");
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (value.trim()) {
      props.onSave(value.trim());
      setValue("");
      setConfirmingRemove(false);
    }
  };

  const isBusy = props.currentBusyKey === props.busyKey;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className={SECTION_LABEL}>Credentials</p>
          <h2 className="text-lg font-semibold text-on-surface">{props.label}</h2>
          <p className="mt-1 max-w-prose text-sm text-on-surface-variant">{props.description}</p>
        </div>
        {keySourcePill(props.keySource)}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className={CHIP}>per-organization</span>
        <span className={CHIP}>injected at runtime start</span>
        <span className={CHIP}>write-only</span>
      </div>

      {props.successMessage ? (
        <p className="rounded border border-outline-variant bg-success-surface px-3 py-2 text-sm text-success">
          {props.successMessage}
        </p>
      ) : null}

      <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={props.inputId}>{props.label}</Label>
          <Input
            id={props.inputId}
            autoComplete="off"
            type="password"
            value={value}
            placeholder={
              props.tenantKeyConfigured
                ? props.placeholderConfigured
                : props.placeholderUnconfigured
            }
            onChange={(e) => setValue(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={isBusy || !value.trim()}>
            {isBusy ? "Saving..." : "Save API key"}
          </Button>
          {props.tenantKeyConfigured ? (
            confirmingRemove ? (
              <>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={isBusy}
                  onClick={() => {
                    setConfirmingRemove(false);
                    props.onRemove();
                  }}
                >
                  Confirm removal
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={isBusy}
                  onClick={() => setConfirmingRemove(false)}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                type="button"
                variant="outline"
                disabled={isBusy}
                onClick={() => setConfirmingRemove(true)}
              >
                Remove key
              </Button>
            )
          ) : null}
        </div>
      </form>
    </div>
  );
}

/** Example key prefixes shown as input placeholders per provider. */
const PROVIDER_KEY_PLACEHOLDER: Record<ModelProvider, string> = {
  anthropic: "sk-ant-...",
  openai: "sk-...",
  google: "AIza...",
  openrouter: "sk-or-...",
  zai: "..."
};

/** Stable busyKey per provider so only the saving form shows a spinner. */
export function providerKeyBusyKey(provider: ModelProvider): string {
  return `save-${provider}-key`;
}

export function AdminOrganizationCard(props: {
  tenant: TenantDetails | null;
  busyKey: string | null;
  /** Success message keyed by provider (only the last-saved one is set). */
  providerSuccessMessage: Partial<Record<ModelProvider, string | null>>;
  /**
   * Per-provider key source from GET /admin/models. Optional so the card
   * degrades to tenant-key presence alone while the catalog loads.
   */
  providerStatuses?: AdminProviderStatus[];
  onSaveProviderKey: (provider: ModelProvider, apiKey: string) => void;
}) {
  const statusByProvider = new Map(
    (props.providerStatuses ?? []).map((status) => [status.id, status])
  );
  return (
    <Card>
      <CardContent className="flex flex-col gap-8 pt-6">
        {MODEL_PROVIDERS.map((provider) => {
          const meta = MODEL_PROVIDER_META[provider];
          const tenantKeyConfigured = Boolean(props.tenant?.settings.providerKeys?.[provider]);
          const keySource: KeySource =
            statusByProvider.get(provider)?.keySource ??
            (tenantKeyConfigured ? "tenant" : "none");
          const placeholder = PROVIDER_KEY_PLACEHOLDER[provider];
          return (
            <ApiKeyForm
              key={provider}
              inputId={`${provider}-api-key`}
              label={`${meta.label} API key`}
              description={`Set the ${meta.label} API key for this organization. Together with the provider toggle below, it makes ${meta.label} models selectable in the model picker. This key is injected into the runtime when agent sessions start and is never exposed after saving.`}
              keySource={keySource}
              tenantKeyConfigured={tenantKeyConfigured}
              busyKey={providerKeyBusyKey(provider)}
              currentBusyKey={props.busyKey}
              successMessage={props.providerSuccessMessage[provider] ?? null}
              placeholderConfigured={`${placeholder} (leave blank to keep current)`}
              placeholderUnconfigured={placeholder}
              onSave={(apiKey) => props.onSaveProviderKey(provider, apiKey)}
              onRemove={() => props.onSaveProviderKey(provider, "")}
            />
          );
        })}
      </CardContent>
    </Card>
  );
}
