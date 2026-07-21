"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

import type { AdminManagedTool } from "../lib/admin-api";
import type { AdminMcpServer } from "@cogniplane/shared-types";
import type { PolicyEnforcementMode, TenantSettings } from "@cogniplane/shared-types";
import type { TenantSettingsInput } from "../hooks/use-tenant-settings";
import {
  buildDraft,
  formatRelativeTime,
  toApprovalPolicy,
  toggleInArray,
  type ApprovalPolicyKind,
  type FormDraft
} from "./tenant-settings-form.logic";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { PILL_GRAY, SECTION_LABEL } from "../lib/ui-tokens";

const FORM_SECTION_LABEL =
  "text-[0.7rem] font-semibold uppercase tracking-[0.12em] text-on-surface-variant";

type UpdateDraft = (recipe: (current: FormDraft) => FormDraft) => void;

type Props = {
  settings: TenantSettings;
  saving: boolean;
  onSave: (input: TenantSettingsInput) => Promise<boolean>;
  managedTools: AdminManagedTool[];
  mcpServers: AdminMcpServer[];
  anthropicKeyConfigured: boolean;
  isOwner: boolean;
};

const GRANULAR_APPROVAL_DEFS = [
  {
    key: "sandbox_approval" as const,
    label: "Sandbox operations",
    hint: "Gate filesystem writes and sandbox mutations."
  },
  {
    key: "mcp_elicitations" as const,
    label: "MCP elicitations",
    hint: "Gate tool elicitation requests from MCP servers."
  },
  {
    key: "rules" as const,
    label: "Rules",
    hint: "Gate runtime rules changes."
  },
  {
    key: "request_permissions" as const,
    label: "Permission requests",
    hint: "Gate explicit permission escalation."
  },
  {
    key: "skill_approval" as const,
    label: "Skill invocations",
    hint: "Gate skill activation before execution."
  }
];

const PERMISSION_DEFS = [
  {
    key: "autoApproveReadOnlyTools" as const,
    label: "Auto-approve read-only tools",
    hint: "Agent can use read-only tools without asking for approval.",
    ownerOnly: false
  },
  {
    key: "allowCommandExecution" as const,
    label: "Allow command execution",
    hint: "Agent can run shell commands in the sandbox.",
    ownerOnly: true
  },
  {
    key: "allowUserTokenForwarding" as const,
    label: "Forward user tokens",
    hint: "Pass user authentication tokens to MCP servers.",
    ownerOnly: true
  }
];

function CheckboxRow(props: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex items-start gap-2 text-sm ${
        props.disabled ? "text-on-surface-faint" : "text-on-surface"
      }`}
    >
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.checked)}
        className="mt-0.5 size-4 rounded border-outline-variant accent-primary disabled:cursor-not-allowed disabled:opacity-50"
      />
      <span className="flex-1">
        <strong className="font-semibold">{props.label}</strong>
        {props.hint ? (
          <span className="mt-0.5 block text-xs text-on-surface-faint">{props.hint}</span>
        ) : null}
      </span>
    </label>
  );
}

export function TenantSettingsForm({
  settings,
  saving,
  onSave,
  managedTools,
  mcpServers,
  anthropicKeyConfigured,
  isOwner
}: Props) {
  const [draft, setDraft] = useState<FormDraft>(() => buildDraft(settings));
  const [isDirty, setIsDirty] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);

  // User edits must go through here (never setDraft directly) so the resync
  // effect knows to protect them.
  function updateDraft(recipe: (current: FormDraft) => FormDraft): void {
    setIsDirty(true);
    setDraft(recipe);
  }

  useEffect(() => {
    // A refocus refetch must not clobber in-progress edits. A successful save
    // clears isDirty, re-running this against the already-updated settings.
    if (isDirty) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft(buildDraft(settings));
  }, [settings, isDirty]);

  const sortedTools = useMemo(
    () => [...managedTools].sort((a, b) => a.id.localeCompare(b.id)),
    [managedTools]
  );
  const sortedMcpServers = useMemo(
    () =>
      [...mcpServers]
        .filter((server) => server.enabled)
        .sort((a, b) => a.serverName.localeCompare(b.serverName)),
    [mcpServers]
  );
  const knownToolIds = useMemo(() => new Set(sortedTools.map((tool) => tool.id)), [sortedTools]);
  const knownServerIds = useMemo(
    () => new Set(sortedMcpServers.map((server) => server.serverId)),
    [sortedMcpServers]
  );
  const orphanedToolIds = useMemo(
    () => draft.enabledToolIds.filter((id) => !knownToolIds.has(id)),
    [draft.enabledToolIds, knownToolIds]
  );
  const orphanedServerIds = useMemo(
    () => draft.enabledMcpServerIds.filter((id) => !knownServerIds.has(id)),
    [draft.enabledMcpServerIds, knownServerIds]
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const ok = await onSave({
      showEffortSelector: draft.showEffortSelector,
      webSearchMode: draft.webSearchMode,
      approvalPolicy: toApprovalPolicy(draft.approvalPolicyKind, draft.granularFlags),
      approvalReviewer: draft.approvalReviewer,
      allowCommandExecution: draft.allowCommandExecution,
      allowUserTokenForwarding: draft.allowUserTokenForwarding,
      autoApproveReadOnlyTools: draft.autoApproveReadOnlyTools,
      policyEnforcementMode: draft.policyEnforcementMode,
      developerInstructions: draft.developerInstructions.trim() || null,
      enabledToolIds: draft.enabledToolIds,
      enabledMcpServerIds: draft.enabledMcpServerIds
    });
    if (ok) {
      setIsDirty(false);
      setShowSuccess(true);
      setTimeout(() => setShowSuccess(false), 3000);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className={SECTION_LABEL}>Guardrails</p>
            <h2 className="text-lg font-semibold text-on-surface">Agent settings</h2>
            <p className="mt-1 max-w-prose text-sm text-on-surface-variant">
              Configure approval posture, execution permissions, tool access, and developer
              instructions for all agent sessions in this tenant.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={PILL_GRAY}>v{settings.version}</span>
            <span className={PILL_GRAY}>Updated {formatRelativeTime(settings.updatedAt)}</span>
          </div>
        </div>
      </CardHeader>

      <CardContent>
        <form className="flex flex-col gap-6" onSubmit={(event) => void handleSubmit(event)}>
          <RuntimeSection
            draft={draft}
            updateDraft={updateDraft}
            anthropicKeyConfigured={anthropicKeyConfigured}
          />

          <div className="border-t border-outline-variant" />

          <ApprovalPolicySection draft={draft} updateDraft={updateDraft} />

          <div className="border-t border-outline-variant" />

          <PermissionsSection draft={draft} updateDraft={updateDraft} isOwner={isOwner} />

          <div className="border-t border-outline-variant" />

          <ToolsIntegrationsSection
            draft={draft}
            updateDraft={updateDraft}
            sortedTools={sortedTools}
            sortedMcpServers={sortedMcpServers}
            orphanedToolIds={orphanedToolIds}
            orphanedServerIds={orphanedServerIds}
          />

          <div className="border-t border-outline-variant" />

          <DeveloperInstructionsSection draft={draft} updateDraft={updateDraft} />

          <div className="flex flex-wrap items-center gap-3">
            {showSuccess ? (
              <span className="rounded border border-outline-variant bg-success-surface px-3 py-1.5 text-sm text-success">
                Settings saved successfully.
              </span>
            ) : null}
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save settings"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function RuntimeSection(props: {
  draft: FormDraft;
  updateDraft: UpdateDraft;
  anthropicKeyConfigured: boolean;
}) {
  const { draft, updateDraft, anthropicKeyConfigured } = props;

  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className={FORM_SECTION_LABEL}>Runtime</p>
        <p className="mt-1 text-xs text-on-surface-faint">
          All sessions run on the Deep Agents runtime (Anthropic models). The API key is
          configured in Organization settings.
        </p>
      </div>

      {!anthropicKeyConfigured ? (
        <p className="text-sm text-danger">
          No Anthropic API key is configured — agent turns will fail. Add one in Organization
          settings.
        </p>
      ) : null}

      <CheckboxRow
        checked={draft.showEffortSelector}
        onChange={(checked) =>
          updateDraft((current) => ({ ...current, showEffortSelector: checked }))
        }
        label="Show effort selector in chat"
        hint="Lets users pick reasoning depth when the selected model supports it."
      />

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="web-search-mode">Web search</Label>
        <Select
          value={draft.webSearchMode}
          onValueChange={(value) =>
            updateDraft((current) => ({
              ...current,
              webSearchMode: value as FormDraft["webSearchMode"]
            }))
          }
        >
          <SelectTrigger id="web-search-mode" className="w-full sm:w-80">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="disabled">Disabled</SelectItem>
            <SelectItem value="cached">Cached</SelectItem>
            <SelectItem value="live">Live</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-on-surface-faint">
          Web-search posture for agent turns. &ldquo;Cached&rdquo; uses an indexed snapshot;
          &ldquo;Live&rdquo; hits the network.
        </p>
      </div>
    </div>
  );
}

function ApprovalPolicySection(props: { draft: FormDraft; updateDraft: UpdateDraft }) {
  const { draft, updateDraft } = props;

  return (
    <div className="flex flex-col gap-3">
      <p className={FORM_SECTION_LABEL}>Approval policy</p>
      <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="approval-mode">Approval mode</Label>
            <Select
              value={draft.approvalPolicyKind}
              onValueChange={(value) =>
                updateDraft((current) => ({
                  ...current,
                  approvalPolicyKind: value as ApprovalPolicyKind
                }))
              }
            >
              <SelectTrigger id="approval-mode" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="never">Never require approval</SelectItem>
                <SelectItem value="on-request">
                  Require approval for all tool calls
                </SelectItem>
                <SelectItem value="granular">Granular (per category)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {draft.approvalPolicyKind === "granular" ? (
            <div className="flex flex-col gap-2">
              {GRANULAR_APPROVAL_DEFS.map(({ key, label, hint }) => (
                <CheckboxRow
                  key={key}
                  checked={draft.granularFlags[key]}
                  onChange={(checked) =>
                    updateDraft((current) => ({
                      ...current,
                      granularFlags: { ...current.granularFlags, [key]: checked }
                    }))
                  }
                  label={label}
                  hint={hint}
                />
              ))}
            </div>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="approval-reviewer">Approval reviewer</Label>
          <Select
            value={draft.approvalReviewer}
            onValueChange={(value) =>
              updateDraft((current) => ({
                ...current,
                approvalReviewer: value as "user" | "guardian_subagent"
              }))
            }
          >
            <SelectTrigger id="approval-reviewer" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="user">User (human in the loop)</SelectItem>
              <SelectItem value="guardian_subagent">
                Guardian sub-agent (automated)
              </SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-on-surface-variant">
            Applies to runtime-native shell, file, and permission prompts. Policy Center actor
            confirmations are always decided by the user who initiated the turn.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="policy-enforcement-mode">Policy Center enforcement</Label>
          <Select
            value={draft.policyEnforcementMode}
            onValueChange={(value) =>
              updateDraft((current) => ({
                ...current,
                policyEnforcementMode: value as PolicyEnforcementMode
              }))
            }
          >
            <SelectTrigger id="policy-enforcement-mode" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="monitor">Monitor (record only)</SelectItem>
              <SelectItem value="enforce">Enforce (gate matching actions)</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-on-surface-faint">
            When enforce, Policy Center rules that block or require approval actually gate
            tool calls. Monitor records decisions without gating.
          </p>
        </div>
      </div>
    </div>
  );
}

function PermissionsSection(props: { draft: FormDraft; updateDraft: UpdateDraft; isOwner: boolean }) {
  const { draft, updateDraft, isOwner } = props;

  return (
    <div className="flex flex-col gap-3">
      <p className={FORM_SECTION_LABEL}>Permissions</p>
      <div className="flex flex-col gap-2">
        {PERMISSION_DEFS.map(({ key, label, hint, ownerOnly }) => (
          <CheckboxRow
            key={key}
            checked={draft[key]}
            onChange={(checked) =>
              updateDraft((current) => ({ ...current, [key]: checked }))
            }
            label={label}
            hint={ownerOnly && !isOwner ? `${hint} Owner role required to change this setting.` : hint}
            disabled={ownerOnly && !isOwner}
          />
        ))}
      </div>
    </div>
  );
}

function ToolsIntegrationsSection(props: {
  draft: FormDraft;
  updateDraft: UpdateDraft;
  sortedTools: AdminManagedTool[];
  sortedMcpServers: AdminMcpServer[];
  orphanedToolIds: string[];
  orphanedServerIds: string[];
}) {
  const { draft, updateDraft, sortedTools, sortedMcpServers, orphanedToolIds, orphanedServerIds } =
    props;

  return (
    <div className="flex flex-col gap-3">
      <p className={FORM_SECTION_LABEL}>Tools &amp; integrations</p>
      <div className="grid grid-cols-1 items-start gap-6 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <p className="text-xs text-on-surface-faint">
            Managed tools available to this tenant. Tools left unchecked are hidden from the
            runtime.
          </p>
          {sortedTools.length === 0 ? (
            <p className="text-sm text-on-surface-faint">No managed tools registered.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {sortedTools.map((tool) => (
                <CheckboxRow
                  key={tool.id}
                  checked={draft.enabledToolIds.includes(tool.id)}
                  onChange={(checked) =>
                    updateDraft((current) => ({
                      ...current,
                      enabledToolIds: toggleInArray(current.enabledToolIds, tool.id, checked)
                    }))
                  }
                  label={tool.id + (tool.readOnly ? "  (Read-only)" : "")}
                  hint={tool.description}
                />
              ))}
            </div>
          )}
          {orphanedToolIds.length > 0 ? (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-on-surface-faint">
                These tool IDs are configured but no longer in the catalog. Uncheck to remove.
              </p>
              {orphanedToolIds.map((id) => (
                <CheckboxRow
                  key={id}
                  checked={true}
                  onChange={(checked) =>
                    updateDraft((current) => ({
                      ...current,
                      enabledToolIds: toggleInArray(current.enabledToolIds, id, checked)
                    }))
                  }
                  label={id}
                  hint="Unknown tool — not in catalog."
                />
              ))}
            </div>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          <p className="text-xs text-on-surface-faint">
            MCP servers exposed to the runtime. Manage servers in the MCP servers section.
          </p>
          {sortedMcpServers.length === 0 ? (
            <p className="text-sm text-on-surface-faint">No MCP servers registered.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {sortedMcpServers.map((server) => (
                <CheckboxRow
                  key={server.serverId}
                  checked={draft.enabledMcpServerIds.includes(server.serverId)}
                  onChange={(checked) =>
                    updateDraft((current) => ({
                      ...current,
                      enabledMcpServerIds: toggleInArray(
                        current.enabledMcpServerIds,
                        server.serverId,
                        checked
                      )
                    }))
                  }
                  label={`${server.serverName} (${server.mode})`}
                  hint={server.description ?? server.serverId}
                />
              ))}
            </div>
          )}
          {orphanedServerIds.length > 0 ? (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-on-surface-faint">
                These server IDs are configured but no longer registered. Uncheck to remove.
              </p>
              {orphanedServerIds.map((id) => (
                <CheckboxRow
                  key={id}
                  checked={true}
                  onChange={(checked) =>
                    updateDraft((current) => ({
                      ...current,
                      enabledMcpServerIds: toggleInArray(
                        current.enabledMcpServerIds,
                        id,
                        checked
                      )
                    }))
                  }
                  label={id}
                  hint="Unknown server — not registered."
                />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function DeveloperInstructionsSection(props: { draft: FormDraft; updateDraft: UpdateDraft }) {
  const { draft, updateDraft } = props;

  return (
    <div className="flex flex-col gap-3">
      <p className={FORM_SECTION_LABEL}>Developer instructions</p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="developer-instructions">Custom system prompt</Label>
        <Textarea
          id="developer-instructions"
          value={draft.developerInstructions}
          onChange={(event) =>
            updateDraft((current) => ({
              ...current,
              developerInstructions: event.target.value
            }))
          }
          placeholder="Optional system-level guidance injected at thread start. Use this to set tone, constraints, or context for all agent sessions."
          rows={6}
        />
      </div>
    </div>
  );
}
