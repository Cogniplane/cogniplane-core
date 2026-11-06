"use client";

import { useEffect, useRef, useState } from "react";
import { StepUpRefusalSchema, type StepUpAction } from "@cogniplane/shared-types";

import { ApiError, setStepUpPrompt, StepUpCancelledError } from "../lib/api-client";
import { StepUpDialog } from "./admin/people/step-up-dialog";

// The one step-up dialog of the request layer (lib/api-client.ts). When the
// backend refuses a request with a 403 that names a step-up action, the
// request layer asks here for a fresh proof, gets a single-use token for that
// action, and sends the same request once more with it. One prompt per save.
// The actions with copy here are the organization changes that email every
// owner: data settings, weaker controls, and skill releases.

type Copy = { title: string; confirmLabel: string; description: string };

const DATA_SETTING = "This setting controls where your organization's data goes. All owners get an email about this change.";
const WEAKER_POLICY = "This change makes the policy less strict for some tool calls. All owners get an email about this change.";
const WEAKER_PII = "This change makes the PII protection weaker. All owners get an email about this change.";
const SKILL_RELEASE = "After this release, the agents of your users follow this skill. All owners get an email about this change.";
const SKILL_SOURCE = "This address controls where admins import skills from. All owners get an email about this change.";
const PROJECT_SKILL_RELEASE = "After this release, the agents of the people who can edit this project follow this skill. All owners get an email about this change.";

const COPY: Partial<Record<StepUpAction, Copy>> = {
  "tenant.provider_key": { title: "Change the provider API key", confirmLabel: "Save key", description: DATA_SETTING },
  "tenant.settings": { title: "Save the organization settings", confirmLabel: "Save", description: DATA_SETTING },
  "mcp_server.create": { title: "Add the MCP server", confirmLabel: "Add", description: DATA_SETTING },
  "mcp_server.setup_create": { title: "Add the MCP server", confirmLabel: "Add", description: DATA_SETTING },
  "mcp_server.update": { title: "Save the MCP server", confirmLabel: "Save", description: DATA_SETTING },
  "mcp_server.setup_update": { title: "Save the MCP server", confirmLabel: "Save", description: DATA_SETTING },
  "mcp_server.inherited_audience": { title: "Change who can use this MCP server", confirmLabel: "Save", description: DATA_SETTING },
  "mcp_server.widget_domain": { title: "Approve the widget domain", confirmLabel: "Approve", description: DATA_SETTING },
  "integration.update": { title: "Save the integration settings", confirmLabel: "Save", description: DATA_SETTING },
  "integration.overlay_settings": { title: "Save the integration settings", confirmLabel: "Save", description: DATA_SETTING },
  "policy.rule_create": { title: "Add the policy rule", confirmLabel: "Add rule", description: WEAKER_POLICY },
  "policy.rule_update": { title: "Save the policy rule", confirmLabel: "Save rule", description: WEAKER_POLICY },
  "policy.rule_delete": { title: "Delete the policy rule", confirmLabel: "Delete rule", description: WEAKER_POLICY },
  "policy.rule_order": { title: "Change the order of the policy rules", confirmLabel: "Save order", description: WEAKER_POLICY },
  "tenant.pii_settings": { title: "Save the PII protection settings", confirmLabel: "Save", description: WEAKER_PII },
  "tenant.skill_marketplace": { title: "Save the skill marketplace address", confirmLabel: "Save", description: SKILL_SOURCE },
  "skill.revision_activate": { title: "Release this skill revision", confirmLabel: "Release", description: SKILL_RELEASE },
  "skill.publish": { title: "Release this skill to all members", confirmLabel: "Release", description: SKILL_RELEASE },
  "skill.submission_release": { title: "Release the submitted skill", confirmLabel: "Release", description: SKILL_RELEASE },
  "skill.project_release": { title: "Release this project skill", confirmLabel: "Release", description: PROJECT_SKILL_RELEASE }
};

type Pending = {
  action: StepUpAction;
  resend: (stepUpToken: string) => Promise<Response>;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
};

/** A step-up refusal of the request sent again (for example, the proof was not strong enough): the dialog shows it, and the user tries again. */
async function stepUpRefusalOf(response: Response, action: StepUpAction): Promise<ApiError | null> {
  if (response.status !== 403) return null;
  try {
    const refusal = StepUpRefusalSchema.safeParse(await response.clone().json());
    if (!refusal.success) return null;
    return new ApiError({ status: 403, code: refusal.data.error, method: "", path: "", message: `${refusal.data.error}: ${action}` });
  } catch {
    return null;
  }
}

export function StepUpHost() {
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);

  useEffect(() => {
    setStepUpPrompt((action, resend) => new Promise<Response>((resolve, reject) => {
      const next = { action, resend, resolve, reject };
      pendingRef.current = next;
      setPending(next);
    }));
    return () => {
      setStepUpPrompt(null);
      pendingRef.current?.reject(new StepUpCancelledError());
      pendingRef.current = null;
    };
  }, []);

  const settle = () => {
    pendingRef.current = null;
    setPending(null);
  };

  const copy = (pending && COPY[pending.action]) ??
    { title: "Confirm this change", confirmLabel: "Confirm", description: "This change needs your confirmation." };

  return pending ? (
    <StepUpDialog
      open
      onOpenChange={(open) => {
        if (open) return;
        // Closed with no answer: the user cancelled.
        pendingRef.current?.reject(new StepUpCancelledError());
        settle();
      }}
      action={pending.action}
      title={copy.title}
      description={copy.description}
      confirmLabel={copy.confirmLabel}
      run={async (stepUpToken) => {
        const current = pendingRef.current;
        if (!current) return;
        const response = await current.resend(stepUpToken);
        const refusal = await stepUpRefusalOf(response, current.action);
        if (refusal) throw refusal;
        // Any other answer goes back to the page that sent the request.
        current.resolve(response);
        settle();
      }}
    />
  ) : null;
}
