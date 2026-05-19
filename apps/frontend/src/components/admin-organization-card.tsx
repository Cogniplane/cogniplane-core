"use client";

import { useState } from "react";

import type { TenantDetails } from "@cogniplane/shared-types";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const SECTION_LABEL =
  "text-[0.62rem] font-bold uppercase tracking-[0.14em] text-on-surface-faint";
const PILL_BASE = "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium";
const PILL_GREEN = `${PILL_BASE} bg-success-surface text-success`;
const PILL_GRAY = `${PILL_BASE} bg-surface-container text-on-surface-variant`;
const CHIP =
  "inline-flex items-center rounded bg-surface-container px-1.5 py-0.5 text-xs text-on-surface-variant";

type ApiKeyFormProps = {
  inputId: string;
  label: string;
  description: string;
  configured: boolean;
  busy: boolean;
  busyKey: string;
  currentBusyKey: string | null;
  successMessage: string | null;
  placeholderConfigured: string;
  placeholderUnconfigured: string;
  onSave: (apiKey: string) => void;
};

function ApiKeyForm(props: ApiKeyFormProps) {
  const [value, setValue] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (value.trim()) {
      props.onSave(value.trim());
      setValue("");
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
        <span className={props.configured ? PILL_GREEN : PILL_GRAY}>
          {props.configured ? "configured" : "not configured"}
        </span>
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
              props.configured ? props.placeholderConfigured : props.placeholderUnconfigured
            }
            onChange={(e) => setValue(e.target.value)}
          />
        </div>
        <div>
          <Button type="submit" disabled={isBusy || !value.trim()}>
            {isBusy ? "Saving..." : "Save API key"}
          </Button>
        </div>
      </form>
    </div>
  );
}

export function AdminOrganizationCard(props: {
  tenant: TenantDetails | null;
  busyKey: string | null;
  openaiSuccessMessage: string | null;
  anthropicSuccessMessage: string | null;
  onSaveApiKey: (apiKey: string) => void;
  onSaveAnthropicKey: (apiKey: string) => void;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-6 pt-6">
        <ApiKeyForm
          inputId="openai-api-key"
          label="OpenAI API key"
          description="Set the OpenAI API key for this organization. This key is injected into the runtime when agent sessions start and is never exposed after saving."
          configured={Boolean(props.tenant?.settings.openaiApiKeyConfigured)}
          busy={props.busyKey === "save-api-key"}
          busyKey="save-api-key"
          currentBusyKey={props.busyKey}
          successMessage={props.openaiSuccessMessage}
          placeholderConfigured="sk-... (leave blank to keep current)"
          placeholderUnconfigured="sk-..."
          onSave={props.onSaveApiKey}
        />

        <div className="border-t border-outline-variant" />

        <ApiKeyForm
          inputId="anthropic-api-key"
          label="Anthropic API key"
          description="Set the Anthropic API key for this organization. Required for the Claude Code runtime provider. This key is injected into the runtime when agent sessions start and is never exposed after saving."
          configured={Boolean(props.tenant?.settings.anthropicApiKeyConfigured)}
          busy={props.busyKey === "save-anthropic-key"}
          busyKey="save-anthropic-key"
          currentBusyKey={props.busyKey}
          successMessage={props.anthropicSuccessMessage}
          placeholderConfigured="sk-ant-... (leave blank to keep current)"
          placeholderUnconfigured="sk-ant-..."
          onSave={props.onSaveAnthropicKey}
        />
      </CardContent>
    </Card>
  );
}
