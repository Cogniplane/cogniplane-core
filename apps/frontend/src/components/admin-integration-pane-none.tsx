"use client";

import type { AdminIntegrationView } from "@cogniplane/shared-types";

const PILL_BASE = "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium";
const PILL_GREEN = `${PILL_BASE} bg-success-surface text-success`;
const PILL_RED = `${PILL_BASE} bg-danger-surface text-danger`;

export function AdminIntegrationPaneNone(props: { integration: AdminIntegrationView }) {
  const { integration } = props;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-outline-variant bg-surface-container-low p-3">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
        Platform configuration
      </h4>
      {integration.platformConfigured ? (
        <p className="text-sm text-on-surface-variant">
          <span className={PILL_GREEN}>Configured</span>{" "}
          <span>Configured by the platform operator.</span>
        </p>
      ) : (
        <p className="text-sm text-on-surface-variant">
          <span className={PILL_RED}>Not configured</span>{" "}
          <span>
            {integration.platformConfigMessage ??
              "Backend environment variables required to enable this integration are missing."}
          </span>
        </p>
      )}
      <p className="text-sm text-on-surface-faint">
        Once enabled, each user authorizes their own account from{" "}
        <code className="rounded bg-surface-container px-1 py-0.5 text-[0.7rem]">
          /settings/{integration.id}
        </code>
        .
      </p>
    </div>
  );
}
