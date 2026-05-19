"use client";

import type { AdminIntegrationView } from "@cogniplane/shared-types";
import { IntegrationLogo } from "./integration-logo";
import { AdminIntegrationPaneNone } from "./admin-integration-pane-none";
import { AdminIntegrationPaneOauthApp } from "./admin-integration-pane-oauth-app";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";

const CHIP =
  "inline-flex items-center rounded bg-surface-container px-1.5 py-0.5 text-xs text-on-surface-variant";
const PILL_PLANNED =
  "inline-flex items-center rounded-full bg-surface-container px-2 py-0.5 text-xs font-medium text-on-surface-variant";

type Props = {
  integration: AdminIntegrationView;
  busy: boolean;
  onClose: () => void;
  onSaveConfig: (config: Record<string, string>) => Promise<void>;
  onClearConfig: () => Promise<void>;
};

export function AdminIntegrationPane(props: Props) {
  const { integration, busy, onClose, onSaveConfig, onClearConfig } = props;

  return (
    <Dialog
      open={true}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[560px]">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <IntegrationLogo
              slug={integration.logoSlug}
              name={integration.name}
              category={integration.category}
              size={32}
            />
            <div>
              <DialogTitle>{integration.name}</DialogTitle>
              <DialogDescription>{integration.category}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <p className="text-sm text-on-surface-variant">
            {integration.longDescription || integration.description}
          </p>

          {integration.readToolIds.length > 0 || integration.writeToolIds.length > 0 ? (
            <div className="flex flex-col gap-3 rounded-lg border border-outline-variant bg-surface-container-low p-3">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
                What this enables
              </h4>
              {integration.readToolIds.length > 0 ? (
                <div>
                  <small className="text-xs text-on-surface-faint">Read tools</small>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    {integration.readToolIds.map((id) => (
                      <span key={id} className={CHIP}>
                        {id}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
              {integration.writeToolIds.length > 0 ? (
                <div>
                  <small className="text-xs text-on-surface-faint">Write tools</small>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    {integration.writeToolIds.map((id) => (
                      <span key={id} className={CHIP}>
                        {id}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {integration.status === "coming_soon" ? (
            <div className="rounded-lg border border-outline-variant bg-surface-container-low p-3">
              <p className="text-sm text-on-surface-variant">
                <span className={PILL_PLANNED}>Coming soon</span>{" "}
                <span>
                  This integration is on the roadmap. Toggles are disabled until it ships.
                </span>
              </p>
            </div>
          ) : integration.configMode === "oauth_app" ? (
            <AdminIntegrationPaneOauthApp
              integration={integration}
              busy={busy}
              onSave={onSaveConfig}
              onClear={onClearConfig}
            />
          ) : (
            <AdminIntegrationPaneNone integration={integration} />
          )}

          {integration.docsUrl ? (
            <div className="rounded-lg border border-outline-variant bg-surface-container-low p-3">
              <a
                href={integration.docsUrl}
                target="_blank"
                rel="noreferrer"
                className="text-sm text-accent underline-offset-2 hover:underline"
              >
                Learn more →
              </a>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
