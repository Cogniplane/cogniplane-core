"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import type { AdminProviderStatus, ModelProvider, TenantDetails } from "@cogniplane/shared-types";
import { MODEL_PROVIDERS, MODEL_PROVIDER_META } from "@cogniplane/shared-types";
import { Button } from "@/components/ui/button";
import { DisclosureRow } from "./overview-row";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PILL_BLUE, PILL_GRAY, PILL_GREEN } from "../../lib/ui-tokens";
import { useFeedbackFocus } from "./use-feedback-focus";

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
  tenantKeyConfigured: boolean | null;
  busyKey: string;
  currentBusyKey: string | null;
  writesBlocked: boolean;
  successMessage: string | null;
  errorMessage: string | null;
  placeholderConfigured: string;
  placeholderUnconfigured: string;
  target: boolean;
  onSave: (apiKey: string) => Promise<boolean>;
  onRemove: () => Promise<boolean>;
};

function ApiKeyForm(props: ApiKeyFormProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(props.target);
  const [value, setValue] = useState("");
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const operationRef = useRef(false);
  const [operation, setOperation] = useState<"save" | "remove" | null>(null);
  const resultRef = useRef<HTMLParagraphElement>(null);
  const [localResult, setLocalResult] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const focusResult = useFeedbackFocus();
  const errorMessage = props.errorMessage ?? localError;

  useEffect(() => {
    if (!props.target) return;
    buttonRef.current?.focus({ preventScroll: true });
    rowRef.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }, [props.target]);

  const isBusy = operation !== null || props.currentBusyKey === props.busyKey;
  const disabled = isBusy || props.writesBlocked || props.currentBusyKey !== null || props.tenantKeyConfigured === null;
  const run = async (kind: "save" | "remove", trigger: HTMLElement | null) => {
    if (operationRef.current || disabled) return;
    operationRef.current = true;
    setOperation(kind);
    setLocalResult(null);
    setLocalError(null);
    let ownsFocus = document.activeElement === trigger;
    const pendingTarget = ownsFocus ? resultRef.current ?? trigger : trigger;
    if (ownsFocus) pendingTarget?.focus();
    const moved = (event: FocusEvent) => { if (event.target !== pendingTarget) ownsFocus = false; };
    document.addEventListener("focusin", moved);
    try {
      const ok = await (kind === "remove" ? props.onRemove() : props.onSave(value.trim()));
      if (ok) {
        setValue("");
        setConfirmingRemove(false);
        setLocalResult(`${props.title} organization key ${kind === "remove" ? "removed" : "saved"}.`);
      } else {
        setLocalError(`${props.title} key ${kind === "remove" ? "removal" : "save"} was not confirmed. Your input is kept. Try again.`);
      }
    } finally {
      document.removeEventListener("focusin", moved);
      operationRef.current = false;
      setOperation(null);
      if (ownsFocus && (document.activeElement === pendingTarget || document.activeElement === document.body)) {
        focusResult(() => resultRef.current);
      }
    }
  };
  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (value.trim()) void run("save", document.activeElement as HTMLElement | null);
  };

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
      disabled={isBusy}
      buttonRef={buttonRef}
    >
      <p className="text-sm text-on-surface-variant">{props.description}</p>

      {props.tenantKeyConfigured === null ? <p className="text-sm text-warning">Organization key status is unavailable. Load key status before making changes.</p> : null}
      {!confirmingRemove ? <p ref={resultRef} role="status" tabIndex={-1} className="rounded-sm text-sm text-on-surface-variant outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">{operation ? `Saving ${props.title} organization key...` : localResult ?? (errorMessage ? "Key change was not confirmed. Review the error below." : props.successMessage ?? "Key changes save immediately.")}</p> : null}
      {errorMessage && !confirmingRemove ? <p role="alert" className="text-sm text-danger">{errorMessage}</p> : null}

      <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={props.inputId}>{props.label}</Label>
          <Input
            id={props.inputId}
            autoComplete="off"
            type="password"
            value={value}
            disabled={disabled}
            maxLength={512}
            placeholder={
              props.tenantKeyConfigured
                ? props.placeholderConfigured
                : props.placeholderUnconfigured
            }
            onChange={(e) => setValue(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={disabled || !value.trim()}>
            {operation === "save" ? `Saving ${props.title} key...` : "Save API key"}
          </Button>
          {props.tenantKeyConfigured && !confirmingRemove ? <Button type="button" variant="outline" disabled={disabled} onClick={() => setConfirmingRemove(true)}>Remove key</Button> : null}
        </div>
        {confirmingRemove ? <div className="flex flex-col gap-3 border-t border-outline-variant pt-3">
          <p className="font-medium">Remove the {props.title} organization key?</p>
          <p className="text-sm text-on-surface-variant">This saves immediately. A platform key can still provide access after removal. Provider Use choices are saved separately.</p>
          <p ref={resultRef} role="status" tabIndex={-1} className="rounded-sm text-sm text-on-surface-variant outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">{operation ? `Removing ${props.title} organization key...` : errorMessage ? "Key removal was not confirmed. Review the error below." : "Confirm removal to save this change."}</p>
          <div className="flex flex-wrap gap-2"><Button type="button" variant="destructive" disabled={disabled} onClick={event => void run("remove", event.currentTarget)}>{operation === "remove" ? `Removing ${props.title} key...` : `Remove ${props.title} organization key`}</Button><Button type="button" variant="outline" disabled={isBusy} onClick={() => setConfirmingRemove(false)}>Keep key</Button></div>
          {errorMessage ? <p role="alert" className="text-sm text-danger">{errorMessage}</p> : null}
        </div> : null}
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
  writesBlocked?: boolean;
  /** Success and error messages keyed by provider (only the last-saved one is set). */
  providerSuccessMessage: Partial<Record<ModelProvider, string | null>>;
  providerErrorMessage: Partial<Record<ModelProvider, string | null>>;
  providerStatuses: AdminProviderStatus[];
  onSaveProviderKey: (provider: ModelProvider, apiKey: string) => Promise<boolean>;
  status: (provider: ModelProvider) => string;
  actions: (provider: ModelProvider) => ReactNode;
}) {
  const lock = useRef(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const saveKey = async (provider: ModelProvider, apiKey: string) => {
    if (lock.current || props.busyKey || props.writesBlocked || !props.tenant) return false;
    lock.current = true;
    setActiveKey(providerKeyBusyKey(provider));
    try { return await props.onSaveProviderKey(provider, apiKey); }
    finally { lock.current = false; setActiveKey(null); }
  };
  const statusByProvider = new Map(
    props.providerStatuses.map((status) => [status.id, status])
  );
  return (
    <div className="divide-y divide-outline-variant border-t border-outline-variant">
        {MODEL_PROVIDERS.map((provider) => {
          const meta = MODEL_PROVIDER_META[provider];
          const tenantKeyConfigured = props.tenant ? Boolean(props.tenant.settings.providerKeys?.[provider]) : null;
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
              status={tenantKeyConfigured === null ? `${props.status(provider)} Organization key status is unavailable.` : props.status(provider)}
              actions={props.actions(provider)}
              description={`The key is stored for this organization and cannot be viewed after saving.`}
              keySource={keySource}
              tenantKeyConfigured={tenantKeyConfigured}
              busyKey={providerKeyBusyKey(provider)}
              currentBusyKey={activeKey ?? props.busyKey}
              writesBlocked={Boolean(props.writesBlocked)}
              successMessage={props.providerSuccessMessage[provider] ?? null}
              errorMessage={props.providerErrorMessage[provider] ?? null}
              placeholderConfigured={`${placeholder} (leave blank to keep current)`}
              placeholderUnconfigured={placeholder}
              target={props.targetProvider === provider}
              onSave={(apiKey) => saveKey(provider, apiKey)}
              onRemove={() => saveKey(provider, "")}
            />
          );
        })}
    </div>
  );
}
