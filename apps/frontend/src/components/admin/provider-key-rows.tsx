"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import type { AdminProviderStatus, ModelProvider, TenantDetails } from "@cogniplane/shared-types";
import { MODEL_PROVIDERS, MODEL_PROVIDER_META } from "@cogniplane/shared-types";
import { Button } from "@/components/ui/button";
import { DisclosureRow } from "./overview-row";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PILL_BLUE, PILL_GRAY, PILL_GREEN } from "../../lib/ui-tokens";

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
  title: string;
  label: string;
  status: string;
  /** Other row controls, such as the provider on/off checkbox. */
  actions: ReactNode;
  description: string;
  /** Where the provider's effective key comes from (tenant wins). */
  keySource: KeySource;
  /** Whether an org-level key is stored (the only kind this form can remove). */
  tenantKeyConfigured: boolean;
  busyKey: string;
  currentBusyKey: string | null;
  successMessage: string | null;
  errorMessage: string | null;
  placeholderConfigured: string;
  placeholderUnconfigured: string;
  target: boolean;
  onSave: (apiKey: string) => Promise<boolean>;
  onRemove: () => Promise<unknown>;
};

function ApiKeyForm(props: ApiKeyFormProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(props.target);
  const [value, setValue] = useState("");
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  useEffect(() => {
    if (!props.target) return;
    buttonRef.current?.focus({ preventScroll: true });
    rowRef.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }, [props.target]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (value.trim()) {
      if (await props.onSave(value.trim())) {
        setValue("");
        setConfirmingRemove(false);
      }
    }
  };

  const isBusy = props.currentBusyKey === props.busyKey;

  return (
    <div ref={rowRef}>
    <DisclosureRow
      title={<><span>{props.title}</span>{keySourcePill(props.keySource)}</>}
      status={props.status}
      action={props.tenantKeyConfigured ? "Replace key" : "Set up"}
      actionLabel={`${props.tenantKeyConfigured ? "Replace key" : "Set up"} ${props.title} key`}
      actions={props.actions}
      open={open}
      onOpenChange={setOpen}
      buttonRef={buttonRef}
    >
      <p className="text-sm text-on-surface-variant">{props.description}</p>

      {props.successMessage ? (
        <p className="rounded border border-outline-variant bg-success-surface px-3 py-2 text-sm text-success">
          {props.successMessage}
        </p>
      ) : null}
      {props.errorMessage ? <p role="alert" className="text-sm text-danger">{props.errorMessage}</p> : null}

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
                    void props.onRemove();
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
    </DisclosureRow>
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

/** One row for each model provider: its key status, its key form, and the caller's on/off control. */
export function ProviderKeyRows(props: {
  targetProvider?: ModelProvider | null;
  tenant: TenantDetails | null;
  busyKey: string | null;
  /** Success and error messages keyed by provider (only the last-saved one is set). */
  providerSuccessMessage: Partial<Record<ModelProvider, string | null>>;
  providerErrorMessage: Partial<Record<ModelProvider, string | null>>;
  providerStatuses: AdminProviderStatus[];
  onSaveProviderKey: (provider: ModelProvider, apiKey: string) => Promise<boolean>;
  status: (provider: ModelProvider) => string;
  actions: (provider: ModelProvider) => ReactNode;
}) {
  const statusByProvider = new Map(
    props.providerStatuses.map((status) => [status.id, status])
  );
  return (
    <div className="divide-y divide-outline-variant border-t border-outline-variant">
        {MODEL_PROVIDERS.map((provider) => {
          const meta = MODEL_PROVIDER_META[provider];
          const tenantKeyConfigured = Boolean(props.tenant?.settings.providerKeys?.[provider]);
          const keySource: KeySource =
            statusByProvider.get(provider)?.keySource ??
            (tenantKeyConfigured ? "tenant" : "none");
          const placeholder = PROVIDER_KEY_PLACEHOLDER[provider];
          return (
            <ApiKeyForm
              // A new link to this provider remounts the form so it opens and takes focus.
              key={`${provider}:${props.targetProvider === provider}`}
              inputId={`${provider}-api-key`}
              title={meta.label}
              label={`${meta.label} API key`}
              status={props.status(provider)}
              actions={props.actions(provider)}
              description={`The key is stored for this organization and cannot be viewed after saving.`}
              keySource={keySource}
              tenantKeyConfigured={tenantKeyConfigured}
              busyKey={providerKeyBusyKey(provider)}
              currentBusyKey={props.busyKey}
              successMessage={props.providerSuccessMessage[provider] ?? null}
              errorMessage={props.providerErrorMessage[provider] ?? null}
              placeholderConfigured={`${placeholder} (leave blank to keep current)`}
              placeholderUnconfigured={placeholder}
              target={props.targetProvider === provider}
              onSave={(apiKey) => props.onSaveProviderKey(provider, apiKey)}
              onRemove={() => props.onSaveProviderKey(provider, "")}
            />
          );
        })}
    </div>
  );
}
