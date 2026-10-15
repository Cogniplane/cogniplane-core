"use client";

import type { AdminIntegrationView } from "@cogniplane/shared-types";
import { IntegrationLogo } from "../../integration-logo";
import { Button } from "../../ui/button";
import { OverviewRow } from "../overview-row";

type AdminIntegrationRowProps = {
  integration: AdminIntegrationView;
  busy: boolean;
  onOpen: () => void;
  onToggleReads: (next: boolean) => void;
  onToggleWrites: (next: boolean) => void;
};

type CaptionTone = "gray" | "red" | "green";

const CAPTION_TONE_CLASS: Record<CaptionTone, string> = {
  red: "text-danger",
  green: "text-success",
  gray: "text-on-surface-variant"
};

function statusCaption(integration: AdminIntegrationView): {
  text: string;
  tone: CaptionTone;
} {
  if (!integration.platformConfigured) {
    return {
      text: integration.platformConfigMessage ?? "Platform not configured",
      tone: "red"
    };
  }
  if (integration.configMode !== "none" && !integration.hasConfig) {
    return { text: "Needs configuration", tone: "red" };
  }
  if (integration.readsEnabled || integration.writesEnabled) {
    return { text: "Enabled", tone: "green" };
  }
  return { text: "Disabled", tone: "gray" };
}

export function AdminIntegrationRow(props: AdminIntegrationRowProps) {
  const { integration, busy, onOpen, onToggleReads, onToggleWrites } = props;

  // The list shows no coming-soon rows. The user must always retain the ability to flip a currently-on switch off — even
  // when configuration disappears (e.g. the GitHub App is uninstalled while
  // toggles are still true). Otherwise availability and session tools stay
  // enabled with no UI path to disable them.
  const cannotEnable =
    !integration.platformConfigured ||
    (integration.configMode !== "none" && !integration.hasConfig);

  const readsDisabled =
    busy || (!integration.readsEnabled && cannotEnable);
  const writesDisabled =
    busy || (!integration.writesEnabled && cannotEnable);
  // A read-only integration has nothing to write. Keep a switch that is
  // already on, so that it can still be turned off.
  const showWrites = integration.writeToolIds.length > 0 || integration.writesEnabled;

  const status = statusCaption(integration);
  const action = integration.configMode !== "none" && !integration.hasConfig ? "Configure" : "Details";

  return (
    <OverviewRow
      title={<><span aria-hidden="true" className="inline-flex"><IntegrationLogo slug={integration.logoSlug} name={integration.name} category={integration.category} size={20} /></span>{integration.name}</>}
      status={<span className={CAPTION_TONE_CLASS[status.tone]}>{status.text.endsWith(".") ? status.text : `${status.text}.`}</span>}
    >
      <label className="inline-flex cursor-pointer items-center gap-1.5 text-sm text-on-surface-variant">
        <input
          type="checkbox"
          role="switch"
          aria-label={`Reads for ${integration.name}`}
          checked={integration.readsEnabled}
          disabled={readsDisabled}
          onChange={(e) => onToggleReads(e.currentTarget.checked)}
          className="size-4 rounded border-outline-variant accent-primary disabled:cursor-not-allowed disabled:opacity-50"
        />
        <span>Reads</span>
      </label>
      {showWrites ? <label className="inline-flex cursor-pointer items-center gap-1.5 text-sm text-on-surface-variant">
        <input
          type="checkbox"
          role="switch"
          aria-label={`Writes for ${integration.name}`}
          checked={integration.writesEnabled}
          disabled={writesDisabled}
          onChange={(e) => onToggleWrites(e.currentTarget.checked)}
          className="size-4 rounded border-outline-variant accent-primary disabled:cursor-not-allowed disabled:opacity-50"
        />
        <span>Writes</span>
      </label> : null}
      <Button type="button" variant="outline" size="sm" aria-label={action === "Configure" ? `Configure ${integration.name}` : `Details for ${integration.name}`} onClick={onOpen}>{action}</Button>
    </OverviewRow>
  );
}
