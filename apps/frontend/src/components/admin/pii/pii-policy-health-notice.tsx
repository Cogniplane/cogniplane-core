"use client";

import type { ReactNode } from "react";

import type { PiiPolicyHealth, PiiPolicyHealthReason } from "@cogniplane/shared-types";

const HEALTH_REASONS: Record<PiiPolicyHealthReason, string> = {
  policy_not_object: "The stored policy is not an object.",
  enabled_invalid: "The on/off value is not valid.",
  mode_invalid: "The protection mode is not valid.",
  mode_off_while_enabled: "Protection is on, but the mode is Off.",
  scope_invalid: "A scan scope is not valid, so that scope is scanned.",
  raw_retention_invalid: "The matched values setting is not valid, so matched values are not kept.",
  actions_invalid: "The admin report setting is not valid, so reports are on.",
  detectors_invalid: "The pattern rules setting is not valid, so the rules run first.",
  entity_types_invalid: "The personal data types are not valid, so every type is checked.",
  entity_types_unsupported: "Some personal data types are not supported. Only the supported types are checked.",
  provider_invalid: "The detection model setting is not valid. Detect uses only the pattern rules. Block and Transform cannot run."
};

/**
 * What the server did with a stored policy that is not valid. An admin save
 * repairs it. `action` tells the admin where to save.
 */
export function PiiPolicyHealthNotice({ health, action }: { health: PiiPolicyHealth | undefined; action: ReactNode }) {
  if (!health || health.state === "ok") return null;
  const error = health.state === "error";
  const reasons = health.reasons.map((reason) => HEALTH_REASONS[reason as PiiPolicyHealthReason]).filter(Boolean);
  return (
    <div role={error ? "alert" : "status"} className={`rounded border border-outline-variant px-3 py-2 text-sm [overflow-wrap:anywhere] ${error ? "bg-danger-surface text-danger" : "bg-warning-surface text-warning"}`}>
      <p>
        {error
          ? "The stored PII policy is not valid. Chat prompts, uploads, and imports in scope are stopped before any scan."
          : "Part of the stored PII policy is not valid. Safe values replace it."}{" "}
        {action}
      </p>
      {reasons.length > 0 ? <p>{reasons.join(" ")}</p> : null}
      {health.fields.length > 0 ? <p>Fields: {health.fields.join(", ")}.</p> : null}
    </div>
  );
}
