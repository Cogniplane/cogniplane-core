"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useReducer, useRef, useState, type ReactNode, type Ref } from "react";

import type { AdminManagedTool } from "../lib/admin-api";
import type { TenantSettings } from "@cogniplane/shared-types";
import { DEVELOPER_INSTRUCTIONS_MAX_LENGTH } from "@cogniplane/shared-types";
// Loads a public suffix list, so it is a separate entry point of the package.
import { SANDBOX_EGRESS_DOMAINS_MAX } from "@cogniplane/shared-types/sandbox-egress";
import type { TenantSettingsInput } from "../hooks/use-tenant-settings";
import {
  toggleInArray,
  type ApprovalPolicyKind,
  type FormDraft,
  type ParsedSandboxEgress
} from "./tenant-settings-form.logic";
import {
  affectsApprovals,
  APPROVAL_POLICY_LABELS,
  deriveImpactHighlights,
  toBehaviorInput
} from "./agent-behavior-impact";
import {
  initialFormState,
  selectFormView,
  tenantSettingsFormReducer,
  type ApplyRequest
} from "./tenant-settings-form.state";
import { AgentBehaviorReviewDialog } from "./agent-behavior-review-dialog";
import { useAgentBehaviorDraftStore } from "./agent-behavior-draft-provider";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { PILL_AMBER } from "../lib/ui-tokens";
import { DisclosureRow, OverviewRow } from "./admin/overview-row";
import { SaveBar } from "./admin/save-bar";

type UpdateDraft = (recipe: (current: FormDraft) => FormDraft) => void;

type Props = {
  settings: TenantSettings;
  saving: boolean;
  onSave: (input: TenantSettingsInput) => Promise<boolean>;
  /** Message of the last failed save, shown in the review. */
  saveError?: string | null;
  /** Fetch the saved settings again, to find a concurrent change. */
  onReload?: () => void;
  managedTools: AdminManagedTool[] | undefined;
  toolCatalogState?: "loading" | "failed" | "ready";
  onRetryTools?: () => void;
  modelWarning: string | null;
  isOwner: boolean;
  /** Shown before the settings version, such as the last recorded save. */
  meta?: ReactNode;
};

function toolLabel(id: string, readOnly = false): string {
  return id.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase()) + (readOnly ? " (read only)" : "");
}

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
        props.disabled ? "text-on-surface-variant" : "text-on-surface"
      }`}
    >
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.checked)}
        className="mt-0.5 size-4 shrink-0 rounded border-outline-variant accent-primary disabled:cursor-not-allowed disabled:opacity-50"
      />
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        <strong className="font-semibold">{props.label}</strong>
        {props.hint ? (
          <span className="mt-0.5 block text-xs text-on-surface-variant">{props.hint}</span>
        ) : null}
      </span>
    </label>
  );
}

export function TenantSettingsForm({
  settings,
  saving,
  onSave,
  saveError = null,
  onReload,
  managedTools,
  toolCatalogState = managedTools === undefined ? "loading" : "ready",
  onRetryTools,
  modelWarning,
  isOwner,
  meta
}: Props) {
  const draftStore = useAgentBehaviorDraftStore();
  // The reducer owns the baseline, the draft, the review, the apply request and
  // the confirmed save. See tenant-settings-form.state.ts.
  const [state, dispatch] = useReducer(tenantSettingsFormReducer, null, () =>
    initialFormState(settings, draftStore?.read() ?? null)
  );
  const { baseline, draft, pendingAcknowledgement } = state;
  const sending = state.request.phase === "sending";
  // Opens by itself when a review is refused because of the host list.
  const [networkOpen, setNetworkOpen] = useState(false);
  const [egressFocusRequest, setEgressFocusRequest] = useState(0);
  // Blocks a second apply before React renders the first one.
  const applyingRef = useRef(false);
  const reviewButtonRef = useRef<HTMLButtonElement>(null);
  const egressRef = useRef<HTMLTextAreaElement>(null);
  const saveStatusRef = useRef<HTMLDivElement>(null);
  // Set when the review closes because the draft was saved or discarded.
  const focusStatusOnCloseRef = useRef(false);

  const view = useMemo(() => selectFormView(state, settings), [state, settings]);
  const { changes, hasChanges, egress, conflictVersion } = view;
  const highlights = useMemo(() => deriveImpactHighlights(view.baselineDraft, draft), [view.baselineDraft, draft]);
  const widening = changes.filter((change) => change.tone === "widens").length;
  // A host list that the server would refuse cannot be reviewed or saved. The
  // administrator sees why next to the list, and the draft stays until fixed.
  const egressBlocked = view.hostsBlocked;

  // The reducer compares each new row with the baseline. A newer row can
  // conflict with the draft or follow it without loss. The view reads the
  // current prop, so a conflict shows before this effect runs.
  useEffect(() => {
    dispatch({ type: "settingsReceived", settings });
  }, [settings]);

  useEffect(() => {
    draftStore?.write(hasChanges && pendingAcknowledgement === null ? { baseline, draft } : null);
  }, [draftStore, baseline, draft, hasChanges, pendingAcknowledgement]);

  useEffect(() => {
    if (egressFocusRequest > 0) egressRef.current?.focus();
  }, [egressFocusRequest]);

  function updateDraft(recipe: (current: FormDraft) => FormDraft): void {
    dispatch({ type: "draftEdited", recipe });
  }

  const sortedTools = useMemo(
    () => [...(managedTools ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
    [managedTools]
  );
  const knownToolIds = useMemo(() => new Set(sortedTools.map((tool) => tool.id)), [sortedTools]);
  const orphanedToolIds = useMemo(
    () => toolCatalogState === "ready" && managedTools !== undefined ? draft.enabledToolIds.filter((id) => !knownToolIds.has(id)) : [],
    [draft.enabledToolIds, knownToolIds, toolCatalogState, managedTools]
  );

  function openReview(event?: FormEvent<HTMLFormElement>): void {
    event?.preventDefault();
    if (egressBlocked) {
      setNetworkOpen(true);
      // A closed list cannot take focus. The effect above runs once it is open.
      setEgressFocusRequest((count) => count + 1);
      return;
    }
    // The reducer opens the review only for a draft with changes.
    dispatch({ type: "reviewOpened" });
  }

  async function apply(): Promise<void> {
    if (applyingRef.current || saving || !view.canApply) return;
    applyingRef.current = true;
    // Later edits and rows do not change what this request sends.
    const request: ApplyRequest = { sent: draft, expectedVersion: baseline.version };
    dispatch({ type: "applyStarted", request });
    const ok = await onSave(toBehaviorInput(request.sent, request.expectedVersion));
    applyingRef.current = false;
    if (ok) {
      // Clear even if navigation unmounted the form while the save was pending.
      if (draftStore?.read()?.draft === request.sent) draftStore.write(null);
      focusStatusOnCloseRef.current = true;
      dispatch({ type: "applySucceeded", sent: request.sent });
      return;
    }
    dispatch({ type: "applyFailed" });
    // A version conflict shows as newer saved settings after this refetch.
    onReload?.();
  }

  function rebaseOnLatest(): void {
    dispatch({ type: "rebaseRequested", settings });
  }

  function restoreFocus(): void {
    // The review button is disabled when nothing is left to review.
    const toStatus = focusStatusOnCloseRef.current || !reviewButtonRef.current || reviewButtonRef.current.disabled;
    focusStatusOnCloseRef.current = false;
    (toStatus ? saveStatusRef.current : reviewButtonRef.current)?.focus();
  }

  function discard(): void {
    draftStore?.write(null);
    dispatch({ type: "discarded", settings });
    // The discard buttons go away with the changes.
    if (state.reviewOpen) focusStatusOnCloseRef.current = true;
    else saveStatusRef.current?.focus();
  }

  return (
    <section aria-label="Agent behavior settings">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-on-surface-variant">
        {meta}
        <span aria-hidden="true">·</span>
        <span>v{baseline.version}</span>
      </div>

      <form className="mt-4 flex flex-col" onSubmit={openReview}>
        {modelWarning ? <p role="alert" className="mb-3 text-sm text-danger">{modelWarning}</p> : null}
        <div className="divide-y divide-outline-variant border-t border-outline-variant">
          <ApprovalsRow draft={draft} updateDraft={updateDraft} policyEnforcementMode={settings.policyEnforcementMode} />
          <CommandExecutionRow draft={draft} updateDraft={updateDraft} isOwner={isOwner} />
          <SandboxNetworkRow draft={draft} updateDraft={updateDraft} egress={egress} open={networkOpen}
            onOpenChange={setNetworkOpen} textareaRef={egressRef} />
          <ToolsRow draft={draft} updateDraft={updateDraft} sortedTools={sortedTools} orphanedToolIds={orphanedToolIds}
            catalogState={managedTools === undefined && toolCatalogState === "ready" ? "loading" : toolCatalogState} onRetry={onRetryTools} />
          <InstructionsRow draft={draft} updateDraft={updateDraft} />
        </div>

        <SaveBar
          dirty={hasChanges || egressBlocked}
          busy={sending}
          status={hasChanges || egressBlocked ? (
            <>
              {hasChanges ? (
                <span className="font-medium text-on-surface">
                  {changes.length === 1 ? "1 unsaved change" : `${changes.length} unsaved changes`}
                </span>
              ) : null}
              {widening > 0 ? <span className={PILL_AMBER}>{widening} widen access</span> : null}
              {conflictVersion !== null ? (
                <span className="text-xs text-warning">
                  Organization settings changed to v{conflictVersion} since your draft began. Review to continue.
                </span>
              ) : null}
              {egressBlocked ? (
                <span className="text-xs text-danger">
                  Fix the approved sandbox hosts before you review. The list that is saved has not changed.
                </span>
              ) : null}
            </>
          ) : state.savedVersion !== null ? (
            <span className="text-success">
              Saved as v{state.savedVersion}. Changes that the runtime uses apply from each session&apos;s next turn.
            </span>
          ) : null}
          cancelLabel="Discard changes"
          submitLabel="Review changes"
          onCancel={discard}
          statusRef={saveStatusRef}
          submitRef={reviewButtonRef}
        />
      </form>

      <AgentBehaviorReviewDialog
        open={state.reviewOpen}
        changes={changes}
        highlights={highlights}
        showProjectNote={affectsApprovals(changes)}
        applying={sending || saving}
        failure={state.request.phase === "failed" ? (saveError ?? "The server did not confirm the save.") : null}
        conflictVersion={conflictVersion}
        toolLabel={(id) => {
          const tool = sortedTools.find((entry) => entry.id === id);
          return tool ? toolLabel(tool.id, tool.readOnly) : id;
        }}
        onBack={() => dispatch({ type: "reviewClosed" })}
        onApply={() => void apply()}
        onRebase={rebaseOnLatest}
        onDiscard={discard}
        onRestoreFocus={restoreFocus}
      />
    </section>
  );
}

// The Policies page owns the enforcement mode. Show the saved value, not the draft baseline.
function ApprovalsRow(props: { draft: FormDraft; updateDraft: UpdateDraft; policyEnforcementMode: TenantSettings["policyEnforcementMode"] }) {
  const { draft, updateDraft } = props;
  const never = draft.approvalPolicyKind === "never";
  return (
    <OverviewRow
      title="Approvals"
      status={<>
        {never ? "The agent acts without asking." : "The agent asks before it acts."}
        {!never && draft.autoApproveReadOnlyTools ? " Read-only tools run without asking." : ""}
        {" "}Policy rules {props.policyEnforcementMode === "enforce" ? "also block actions or ask for approval" : "only record decisions"}.
        {" "}<Link href="/admin/policy" className="underline underline-offset-4">Manage policies</Link>
      </>}
    >
      <Select
        // Granular is saved but the runtime treats it like Require approval. Show it that way
        // and keep the saved value until the admin picks a mode.
        value={never ? "never" : "on-request"}
        onValueChange={(value) => updateDraft((current) => ({ ...current, approvalPolicyKind: value as ApprovalPolicyKind }))}
      >
        <SelectTrigger id="approval-mode" aria-label="Approval mode" size="sm" className="w-48">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="on-request">{APPROVAL_POLICY_LABELS["on-request"]}</SelectItem>
          <SelectItem value="never">{APPROVAL_POLICY_LABELS.never}</SelectItem>
        </SelectContent>
      </Select>
      <label className={`flex items-center gap-2 text-sm ${never ? "text-on-surface-variant" : ""}`}>
        <input
          type="checkbox"
          checked={draft.autoApproveReadOnlyTools}
          disabled={never}
          onChange={(event) => {
            const checked = event.target.checked;
            updateDraft((current) => ({ ...current, autoApproveReadOnlyTools: checked }));
          }}
          className="size-4 accent-primary disabled:cursor-not-allowed disabled:opacity-50"
        />
        Auto-approve read-only tools
      </label>
    </OverviewRow>
  );
}

function CommandExecutionRow(props: { draft: FormDraft; updateDraft: UpdateDraft; isOwner: boolean }) {
  const { draft, updateDraft, isOwner } = props;
  return (
    <OverviewRow
      title="Command execution"
      status={`${draft.allowCommandExecution ? "The agent can run shell commands in a sandbox." : "The agent cannot run shell commands."}${isOwner ? "" : " Owner role required to change this setting."}`}
    >
      <label className={`flex items-center gap-2 text-sm ${isOwner ? "" : "text-on-surface-variant"}`}>
        <input
          type="checkbox"
          aria-label="Allow command execution"
          checked={draft.allowCommandExecution}
          disabled={!isOwner}
          onChange={(event) => {
            const checked = event.target.checked;
            updateDraft((current) => ({ ...current, allowCommandExecution: checked }));
          }}
          className="size-4 accent-primary disabled:cursor-not-allowed disabled:opacity-50"
        />
        Allow
      </label>
    </OverviewRow>
  );
}

function SandboxNetworkRow({ draft, updateDraft, egress, open, onOpenChange, textareaRef }: {
  draft: FormDraft;
  updateDraft: UpdateDraft;
  egress: ParsedSandboxEgress;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  textareaRef: Ref<HTMLTextAreaElement>;
}) {
  const count = egress.domains.length;
  const problems = [
    ...egress.errors.map((error) => `Line ${error.line}: "${error.entry}" ${error.message}`),
    ...(egress.tooMany ? [`Approve at most ${SANDBOX_EGRESS_DOMAINS_MAX} hosts. This list has ${count}.`] : [])
  ];
  const status = count === 0
    ? "No hosts approved. Commands in the sandbox cannot reach any network."
    : `${count} ${count === 1 ? "host" : "hosts"} approved. Commands in the sandbox can reach only ${count === 1 ? "this host" : "these hosts"}.`;
  return (
    <DisclosureRow
      title="Sandbox network access"
      action="Edit hosts"
      open={open}
      onOpenChange={onOpenChange}
      status={`${status}${draft.allowCommandExecution ? "" : " Command execution is off, so no sandbox runs yet."}`}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="sandbox-egress-hosts">Approved hosts</Label>
        <Textarea
          id="sandbox-egress-hosts"
          ref={textareaRef}
          rows={5}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          aria-invalid={problems.length > 0}
          aria-describedby="sandbox-egress-help sandbox-egress-problems"
          value={draft.sandboxEgressText}
          onChange={(event) => {
            const text = event.target.value;
            updateDraft((current) => ({ ...current, sandboxEgressText: text }));
          }}
          placeholder={"pypi.org\nfiles.pythonhosted.org\n*.example.com"}
        />
        <div id="sandbox-egress-problems" aria-live="polite">
          {problems.length > 0 ? (
            <ul className="list-disc pl-5 text-xs text-danger">
              {problems.map((problem) => <li key={problem}>{problem}</li>)}
            </ul>
          ) : null}
        </div>
        <div id="sandbox-egress-help" className="flex flex-col gap-1 text-xs text-on-surface-variant">
          <span>
            {count} of {SANDBOX_EGRESS_DOMAINS_MAX} hosts. Enter one host name per line, such as pypi.org.
            Do not enter IP addresses, ports or URLs.
          </span>
          <span>
            A host matches only itself: files.example.com does not approve www.example.com. A line such as
            *.example.com approves every subdomain of example.com, and not example.com itself. Enter both lines to
            approve both. A wildcard cannot cover a public suffix, such as *.com or *.co.uk.
          </span>
          <span>
            The network filter judges a request by the host name it states. While any host is approved, DNS lookups also
            work for every name. Approve only hosts that you would let agent-run code send data to.
          </span>
        </div>
      </div>
    </DisclosureRow>
  );
}

function ToolsRow(props: {
  draft: FormDraft;
  updateDraft: UpdateDraft;
  sortedTools: AdminManagedTool[];
  orphanedToolIds: string[];
  catalogState: "loading" | "failed" | "ready";
  onRetry?: () => void;
}) {
  const { draft, updateDraft, sortedTools, orphanedToolIds, catalogState, onRetry } = props;
  const on = sortedTools.filter((tool) => draft.enabledToolIds.includes(tool.id)).length;
  const known = catalogState === "ready";
  return (
    <DisclosureRow
      title="Built-in tools"
      action="Choose tools"
      status={known
        ? `${sortedTools.length ? `${on} of ${sortedTools.length} tools on.` : "No built-in tools."}${orphanedToolIds.length ? ` ${orphanedToolIds.length} saved tool${orphanedToolIds.length === 1 ? " is" : "s are"} no longer in the catalog.` : ""}`
        : <span role={catalogState === "failed" ? "alert" : "status"} className={catalogState === "failed" ? "text-danger" : undefined}>
          {catalogState === "failed" ? "Could not load the tool catalog." : "Loading the tool catalog..."} Tool choices are kept until the catalog is available.
        </span>}
      actions={catalogState === "failed" && onRetry ? <Button type="button" size="sm" variant="outline" onClick={onRetry}>Retry tools</Button> : null}
    >
      {!known ? <p className="text-sm text-on-surface-variant">{draft.enabledToolIds.length} selected tool{draft.enabledToolIds.length === 1 ? "" : "s"}. Availability has not been confirmed.</p> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        {sortedTools.map((tool) => (
          <CheckboxRow key={tool.id} checked={draft.enabledToolIds.includes(tool.id)}
            disabled={!known}
            onChange={(checked) => updateDraft((current) => ({ ...current, enabledToolIds: toggleInArray(current.enabledToolIds, tool.id, checked) }))}
            label={toolLabel(tool.id, tool.readOnly)}
            hint={tool.description} />
        ))}
        {!known ? draft.enabledToolIds.filter(id => !sortedTools.some(tool => tool.id === id)).map(id => (
          <CheckboxRow key={id} checked disabled onChange={() => {}} label={id} hint="Selected. Catalog availability has not been confirmed." />
        )) : null}
        {orphanedToolIds.map((id) => (
          <CheckboxRow key={id} checked={true}
            onChange={(checked) => updateDraft((current) => ({ ...current, enabledToolIds: toggleInArray(current.enabledToolIds, id, checked) }))}
            label={id} hint="This tool is no longer in the catalog. Clear it to remove it." />
        ))}
      </div>
    </DisclosureRow>
  );
}

function InstructionsRow(props: { draft: FormDraft; updateDraft: UpdateDraft }) {
  const { draft, updateDraft } = props;
  const firstLine = draft.developerInstructions.trim().split("\n")[0];
  return (
    <DisclosureRow
      title="Organization instructions"
      action="Edit instructions"
      status={firstLine ? <span className="line-clamp-1">{firstLine}</span> : "None. Chats use the default instructions."}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="developer-instructions">Custom system prompt</Label>
        <Textarea
          id="developer-instructions"
          maxLength={DEVELOPER_INSTRUCTIONS_MAX_LENGTH}
          aria-describedby="developer-instructions-count"
          value={draft.developerInstructions}
          onChange={(event) => {
            const text = event.target.value;
            updateDraft((current) => ({ ...current, developerInstructions: text }));
          }}
          placeholder="Optional guidance added at the start of every chat. Use it to set tone, limits, or context for all agent sessions."
          rows={6}
        />
        <span id="developer-instructions-count" className="text-xs text-on-surface-variant">
          {draft.developerInstructions.length}/{DEVELOPER_INSTRUCTIONS_MAX_LENGTH} characters
        </span>
      </div>
    </DisclosureRow>
  );
}
