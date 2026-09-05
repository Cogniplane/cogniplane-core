import type { ReactNode } from "react";

import { SECTION_LABEL } from "../lib/ui-tokens";

export function buildOAuthFlashMessage(input: {
  provider: string;
  result: string | null;
  reason: string | null;
  successMessage: string;
}): string | null {
  if (input.result === "connected") return input.successMessage;
  if (input.result === "error") {
    return input.reason
      ? `${input.provider} authorization failed: ${input.reason.replaceAll("_", " ")}.`
      : `${input.provider} authorization failed.`;
  }
  return null;
}

export function OAuthSettingsPage(input: {
  id: string;
  provider: string;
  tenantEnabled: boolean | undefined;
  children: ReactNode;
}) {
  if (input.tenantEnabled !== false) return input.children;

  return (
    <section id={input.id} className="flex flex-col gap-5">
      <div>
        <p className={SECTION_LABEL}>Live module</p>
        <h3 className="text-lg font-semibold text-on-surface">{input.provider}</h3>
      </div>
      <p className="text-sm text-on-surface-faint">
        {input.provider} is not enabled for this tenant. Ask an administrator to enable it from the
        Integrations page.
      </p>
    </section>
  );
}
