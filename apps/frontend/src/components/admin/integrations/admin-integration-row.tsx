"use client";

import type { AdminIntegrationView } from "@cogniplane/shared-types";
import { IntegrationLogo } from "../../integration-logo";
import { PILL_BASE, PILL_GRAY } from "../../../lib/ui-tokens";

const PILL_PLANNED = `${PILL_BASE} bg-surface-container text-on-surface-variant`;

type AdminIntegrationRowProps = {
  integration: AdminIntegrationView;
  busy: boolean;
  onOpen: () => void;
  onToggleReads: (next: boolean) => void;
  onToggleWrites: (next: boolean) => void;
};

type CaptionTone = "blue" | "gray" | "red" | "green" | "planned";

const CAPTION_TONE_CLASS: Record<CaptionTone, string> = {
  red: "text-danger",
  green: "text-success",
  gray: "text-on-surface-variant",
  blue: "text-accent",
  planned: "text-on-surface-faint"
};

function statusCaption(integration: AdminIntegrationView): {
  text: string;
  tone: CaptionTone;
} {
  if (integration.status === "coming_soon") {
    return { text: "Coming soon", tone: "planned" };
  }
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

  // Coming-soon rows can never be flipped on. For everything else, the user
  // must always retain the ability to flip a currently-on switch off — even
  // when configuration disappears (e.g. the GitHub App is uninstalled while
  // toggles are still true). Otherwise availability and session tools stay
  // enabled with no UI path to disable them.
  const cannotEnable =
    integration.status === "coming_soon" ||
    !integration.platformConfigured ||
    (integration.configMode !== "none" && !integration.hasConfig);

  const readsDisabled =
    busy || integration.status === "coming_soon" || (!integration.readsEnabled && cannotEnable);
  const writesDisabled =
    busy || integration.status === "coming_soon" || (!integration.writesEnabled && cannotEnable);

  const status = statusCaption(integration);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        // Ignore key events bubbling up from nested controls (the switches);
        // otherwise Space/Enter on a focused switch would open the pane
        // instead of toggling the switch.
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className="flex cursor-pointer items-center justify-between gap-4 border-b border-outline-variant px-4 py-3.5 transition-colors last:border-b-0 hover:bg-surface-container-low focus-visible:bg-surface-container-low focus-visible:outline-none"
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <IntegrationLogo
          slug={integration.logoSlug}
          name={integration.name}
          category={integration.category}
        />
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <strong className="text-sm font-semibold text-on-surface">
              {integration.name}
            </strong>
            <span className={PILL_GRAY}>{integration.category}</span>
            {integration.status === "coming_soon" ? (
              <span className={PILL_PLANNED}>Coming soon</span>
            ) : null}
          </div>
          <small className={`text-xs ${CAPTION_TONE_CLASS[status.tone]}`}>{status.text}</small>
        </div>
      </div>

      <div className="flex flex-shrink-0 items-center gap-4" onClick={(e) => e.stopPropagation()}>
        <label className="inline-flex cursor-pointer items-center gap-1.5 text-sm text-on-surface-variant">
          <input
            type="checkbox"
            role="switch"
            checked={integration.readsEnabled}
            disabled={readsDisabled}
            onChange={(e) => onToggleReads(e.currentTarget.checked)}
            className="size-4 rounded border-outline-variant accent-primary disabled:cursor-not-allowed disabled:opacity-50"
          />
          <span>Reads</span>
        </label>
        <label className="inline-flex cursor-pointer items-center gap-1.5 text-sm text-on-surface-variant">
          <input
            type="checkbox"
            role="switch"
            checked={integration.writesEnabled}
            disabled={writesDisabled}
            onChange={(e) => onToggleWrites(e.currentTarget.checked)}
            className="size-4 rounded border-outline-variant accent-primary disabled:cursor-not-allowed disabled:opacity-50"
          />
          <span>Writes</span>
        </label>
      </div>
    </div>
  );
}
