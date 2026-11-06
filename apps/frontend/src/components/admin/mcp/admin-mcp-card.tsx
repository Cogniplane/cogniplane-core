"use client";

import { FormEvent, type ReactNode, type Ref, useCallback, useEffect, useRef, useState } from "react";

import type { AdminMcpServer } from "@cogniplane/shared-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/lib/auth-context";
import { toErrorMessage } from "@/lib/error-utils";
import { useConfirmLeave } from "@/hooks/use-confirm-leave";
import { DisclosureRow } from "../overview-row";
import type { McpAudience } from "../../../lib/admin-api";
import { deriveMcpServerId, getMcpAvailability, getMcpUpstreamWarnings } from "./admin-mcp-card.logic";
import { AdminMcpConnectionTestCard, reachabilityLabel } from "./admin-mcp-connection-test";
import { focusMcpElement, MCP_TEXT_FOCUS } from "./admin-mcp-focus";

const CHIP =
  "inline-flex max-w-full break-all items-center rounded bg-surface-container px-1.5 py-0.5 text-xs text-on-surface-variant";

type McpDraft = {
  serverId: string;
  serverName: string;
  description: string;
  mode: "managed" | "proxy";
  routePath: string;
  upstreamUrl: string;
  upstreamAuthType: AdminMcpServer["upstreamAuthType"];
  credentialScope: "organization" | "personal";
  upstreamAuthName: string;
  upstreamAuthSecret: string;
  audience: McpAudience;
  customId: boolean;
  customRoute: boolean;
};

type DecisionAnchor = "form" | "header" | { serverId: string };

const emptyMcpDraft: McpDraft = {
  serverId: "",
  serverName: "",
  description: "",
  mode: "proxy",
  routePath: "/mcp/",
  upstreamUrl: "",
  upstreamAuthType: "none",
  credentialScope: "organization",
  upstreamAuthName: "",
  upstreamAuthSecret: "",
  audience: "off",
  customId: false,
  customRoute: false
};

function draftForServer(server: AdminMcpServer): McpDraft {
  return {
    serverId: server.serverId,
    serverName: server.serverName,
    description: server.description ?? "",
    mode: server.mode,
    routePath: server.routePath,
    upstreamUrl: server.upstreamUrl ?? "",
    upstreamAuthType: server.upstreamAuthType,
    credentialScope: server.credentialScope ?? "organization",
    upstreamAuthName: server.upstreamAuthName ?? "",
    upstreamAuthSecret: "",
    audience: getMcpAvailability(server).audience,
    customId: true,
    customRoute: true
  };
}

function revealEditorStart(form: HTMLFormElement) {
  const firstField = form.querySelector<HTMLElement>("#mcp-server-name, #mcp-built-in-name") ?? form.querySelector<HTMLElement>("h3");
  if (form.getBoundingClientRect().top < 4 || (firstField && firstField.getBoundingClientRect().bottom > window.innerHeight - 4)) {
    form.scrollIntoView?.({ block: "start", behavior: "instant" });
  }
}

export function AdminMcpCard(props: Parameters<typeof AdminMcpEditor>[0]) {
  const { user } = useAuth();
  return <AdminMcpEditor key={`${user?.tenantId ?? ""}:${user?.userId ?? ""}`} {...props} />;
}

function AdminMcpEditor({ headingRef, ...props }: {
  targetServerId?: string | null;
  mcpServers: AdminMcpServer[];
  listGeneration?: number;
  busyKey: string | null;
  onSubmit: (
    input: {
      serverId: string;
      serverName: string;
      description: string | null;
      mode: "managed" | "proxy";
      routePath: string;
      upstreamUrl: string | null;
      upstreamAuthType: AdminMcpServer["upstreamAuthType"];
      credentialScope: "organization" | "personal";
      upstreamAuthName: string | null;
      upstreamAuthSecret?: string | null;
      audience: McpAudience;
    },
    editingId: string | null
  ) => Promise<void>;
  onSetInheritedAudience: (serverId: string, audience: McpAudience) => Promise<void>;
  onTested?: () => void;
  onReload?: () => void | Promise<unknown>;
  listReady?: boolean;
  listNotice?: ReactNode;
  headingRef?: Ref<HTMLHeadingElement>;
  /** More content for the open row of a connection. `open` is true while its row is open. */
  renderServerExtras?: (server: AdminMcpServer, open: boolean) => ReactNode;
}) {
  const targetServer = props.mcpServers.find((server) => server.serverId === props.targetServerId);
  const [mcpDraft, setMcpDraft] = useState<McpDraft>(() => targetServer ? draftForServer(targetServer) : emptyMcpDraft);
  const [editingMcpServerId, setEditingMcpServerId] = useState<string | null>(targetServer?.serverId ?? null);
  const [showForm, setShowForm] = useState(Boolean(targetServer));
  // The open row. It stays open after a save, so the admin can test the saved version.
  const [expandedId, setExpandedId] = useState<string | null>(targetServer?.serverId ?? null);
  const { user } = useAuth();
  const upstreamWarnings = getMcpUpstreamWarnings(mcpDraft.upstreamUrl);
  const formRef = useRef<HTMLFormElement>(null);
  const movingFocus = useRef<{
    editorId: string | undefined;
    control: HTMLElement;
    selection: { start: number; end: number; direction: "forward" | "backward" | "none" } | null;
  } | null>(null);
  const attachForm = useCallback((form: HTMLFormElement | null) => {
    if (!form) {
      const active = document.activeElement;
      if (active instanceof HTMLElement && formRef.current?.contains(active)) {
        const field = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active : null;
        movingFocus.current = {
          editorId: formRef.current.dataset.editorId,
          control: active,
          selection: field?.selectionStart != null && field.selectionEnd != null
            ? { start: field.selectionStart, end: field.selectionEnd, direction: field.selectionDirection ?? "none" }
            : null
        };
      }
      formRef.current = null;
      return;
    }
    formRef.current = form;
    const previous = movingFocus.current;
    movingFocus.current = null;
    if (!previous || previous.editorId !== form.dataset.editorId || document.activeElement !== document.body) return;
    const control = previous.control.id ? document.getElementById(previous.control.id) : null;
    const target = control && form.contains(control) && !control.matches(":disabled") ? control : form;
    target.focus({ preventScroll: true });
    if (previous.selection && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
      target.setSelectionRange(previous.selection.start, previous.selection.end, previous.selection.direction);
    }
    requestAnimationFrame(() => {
      if (document.activeElement !== target || !target.isConnected) return;
      const rect = target.getBoundingClientRect();
      if (rect.top < 4 || rect.bottom > window.innerHeight - 4) target.scrollIntoView?.({ block: "center", behavior: "instant" });
    });
  }, []);
  // A closed editor must not pass its focus to a later task.
  useEffect(() => { movingFocus.current = null; });
  const [initialDraft, setInitialDraft] = useState(() => JSON.stringify(mcpDraft));
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const alive = useRef(true);
  const [localError, setLocalError] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const [reloadError, setReloadError] = useState<string | null>(null);
  const reloadPending = useRef(false);
  const reloadFocus = useRef(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const manageButtons = useRef(new Map<string, HTMLButtonElement>());
  const savedFocus = useRef<string | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const discardFocus = useRef<{ control: HTMLElement | null; serverId: string | null } | null>(null);
  const [decision, setDecision] = useState(false);
  const [decisionReason, setDecisionReason] = useState("");
  const [decisionAnchor, setDecisionAnchor] = useState<DecisionAnchor>("form");
  const nextEditor = useRef<(() => void) | null>(null);
  const invokingControl = useRef<HTMLElement | null>(null);
  const editorFocusRequested = useRef(true);
  const returnToEditor = useRef(false);
  const keepEditingRef = useRef<HTMLButtonElement>(null);
  const decisionRef = useRef<HTMLDivElement>(null);
  const handledTarget = useRef(targetServer ? props.targetServerId : undefined);
  const dirty = showForm && JSON.stringify(mcpDraft) !== initialDraft;
  useConfirmLeave(dirty || saving);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!decision || !editorFocusRequested.current) return;
    focusMcpElement(keepEditingRef.current);
    const revealDecision = () => {
      const question = decisionRef.current;
      if (!question || document.activeElement !== keepEditingRef.current) return;
      const bounds = question.getBoundingClientRect();
      const trigger = typeof decisionAnchor === "object" ? manageButtons.current.get(decisionAnchor.serverId) : null;
      const bottom = Math.max(bounds.bottom, trigger?.getBoundingClientRect().bottom ?? bounds.bottom);
      if (bottom - bounds.top <= window.innerHeight - 8) {
        // Keep the whole question and its requested row visible together.
        const offset = Math.max(bottom - (window.innerHeight - 4), Math.min(0, bounds.top - 4));
        if (offset) window.scrollBy({ top: offset, behavior: "instant" });
      } else {
        // The decision takes priority when the requested row cannot also fit.
        question.scrollIntoView?.({ block: "start", behavior: "instant" });
      }
    };
    let frame = requestAnimationFrame(revealDecision);
    const onResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(revealDecision);
    };
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
    };
  }, [decision, decisionAnchor]);
  useEffect(() => {
    if (!decision && returnToEditor.current) {
      returnToEditor.current = false;
      const form = formRef.current;
      if (form) {
        form.focus({ preventScroll: true });
        revealEditorStart(form);
      }
    } else if (!decision && discardFocus.current) {
      const { control, serverId } = discardFocus.current;
      const target = control?.isConnected ? control : serverId ? manageButtons.current.get(serverId) : addButton.current;
      target?.focus();
      discardFocus.current = null;
    }
  }, [decision]);
  useEffect(() => {
    if (!showForm && props.busyKey === null && savedFocus.current !== null) {
      (manageButtons.current.get(savedFocus.current) ?? addButton.current)?.focus();
      savedFocus.current = null;
    }
  }, [showForm, props.busyKey]);
  const inheritedServer = props.mcpServers.find((server) =>
    server.serverId === editingMcpServerId && server.ownerTenantId === "system"
  );
  const editorMissing = showForm && Boolean(editingMcpServerId) && !props.mcpServers.some(server => server.serverId === editingMcpServerId);
  const editedConnectionName = mcpDraft.serverName.trim()
    || props.mcpServers.find(server => server.serverId === editingMcpServerId)?.serverName.trim()
    || (JSON.parse(initialDraft) as McpDraft).serverName.trim()
    || (editingMcpServerId ? "the saved connection" : "the new connection");

  useEffect(() => {
    if (!reloading && reloadFocus.current) {
      if (document.activeElement === document.body) errorRef.current?.focus();
      reloadFocus.current = false;
    }
  }, [reloading]);

  async function reloadConnections(trigger: HTMLButtonElement) {
    if (reloadPending.current || !props.onReload) return;
    reloadPending.current = true;
    reloadFocus.current = document.activeElement === trigger;
    setReloading(true);
    setReloadError(null);
    try {
      await props.onReload();
    } catch (error) {
      if (alive.current) setReloadError(toErrorMessage(error, "The connection list could not reload. Try again."));
    } finally {
      reloadPending.current = false;
      if (alive.current) setReloading(false);
    }
  }

  function handleCancel() {
    if (savingRef.current) return;
    if (formRef.current?.contains(document.activeElement)) {
      savedFocus.current = editingMcpServerId ?? "";
    }
    setShowForm(false);
    setEditingMcpServerId(null);
    setMcpDraft(emptyMcpDraft);
    setInitialDraft(JSON.stringify(emptyMcpDraft));
    setLocalError(null);
    setReloadError(null);
  }

  function handleEdit(server: AdminMcpServer) {
    if (savingRef.current) return;
    setEditingMcpServerId(server.serverId);
    setMcpDraft(draftForServer(server));
    setShowForm(true);
    setInitialDraft(JSON.stringify(draftForServer(server)));
    setLocalError(null);
    setReloadError(null);
  }

  function requestEditorChange(action: () => void, reason: string, anchor: DecisionAnchor = "form", requestFocus = true) {
    if (savingRef.current) { formRef.current?.focus(); return; }
    editorFocusRequested.current = requestFocus;
    invokingControl.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dirty) { nextEditor.current = action; setDecisionReason(reason); setDecisionAnchor(anchor); setDecision(true); return; }
    action();
  }

  useEffect(() => {
    if (saving || props.listReady === false || handledTarget.current === props.targetServerId) return;
    handledTarget.current = props.targetServerId;
    requestEditorChange(() => {
      const target = props.mcpServers.find(server => server.serverId === props.targetServerId);
      if (target) { setExpandedId(target.serverId); handleEdit(target); }
      else { setExpandedId(null); handleCancel(); }
    }, props.mcpServers.some(server => server.serverId === props.targetServerId)
      ? `open ${props.mcpServers.find(server => server.serverId === props.targetServerId)!.serverName}`
      : "return to the connection list", "form",
      document.activeElement === document.body || Boolean(formRef.current?.contains(document.activeElement)));
    // Target changes are decisions. List refreshes and typing must not replace a draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.targetServerId, props.listReady, saving]);

  useEffect(() => {
    const form = formRef.current;
    if (!showForm || !form || !editorFocusRequested.current) return;
    const entry = editingMcpServerId ? form : form.querySelector<HTMLInputElement>("#mcp-server-name");
    entry?.focus({ preventScroll: true });
    revealEditorStart(form);
  }, [showForm, editingMcpServerId]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (savingRef.current || props.busyKey !== null || decision) return;
    savingRef.current = true;
    setSaving(true);
    setLocalError(null);
    errorRef.current?.focus({ preventScroll: true });
    try {
      if (inheritedServer) {
        await props.onSetInheritedAudience(inheritedServer.serverId, mcpDraft.audience);
      } else {
        await props.onSubmit(
        {
          serverId: mcpDraft.serverId,
          serverName: mcpDraft.serverName,
          description: mcpDraft.description || null,
          mode: mcpDraft.mode,
          routePath: mcpDraft.routePath,
          upstreamUrl: mcpDraft.mode === "proxy" ? mcpDraft.upstreamUrl || null : null,
          upstreamAuthType: mcpDraft.mode === "proxy" ? mcpDraft.upstreamAuthType : "none",
          credentialScope: mcpDraft.mode === "proxy" ? mcpDraft.credentialScope : "organization",
          upstreamAuthName:
            mcpDraft.mode === "proxy" &&
            (mcpDraft.upstreamAuthType === "header" || mcpDraft.upstreamAuthType === "query")
              ? mcpDraft.upstreamAuthName || null
              : null,
          upstreamAuthSecret:
            mcpDraft.mode !== "proxy" || mcpDraft.credentialScope === "personal" || mcpDraft.upstreamAuthType === "none"
              ? null
              : mcpDraft.upstreamAuthSecret || (editingMcpServerId ? undefined : null),
          audience: mcpDraft.audience
        },
        editingMcpServerId
        );
      }
      if (!alive.current) return;
      if (formRef.current?.contains(document.activeElement)) savedFocus.current = inheritedServer?.serverId ?? mcpDraft.serverId;
      setExpandedId(inheritedServer?.serverId ?? mcpDraft.serverId);
      setEditingMcpServerId(null);
      setMcpDraft(emptyMcpDraft);
      setShowForm(false);
      setInitialDraft(JSON.stringify(emptyMcpDraft));
    } catch (error) {
      if (alive.current) setLocalError(`${toErrorMessage(error, "This connection could not be saved.")} Your changes were kept. Save again to retry.`);
    } finally {
      savingRef.current = false;
      if (alive.current) setSaving(false);
    }
  }

  const discardDecision = decision ? <div ref={decisionRef} role="alertdialog" aria-labelledby="mcp-discard-heading" aria-describedby="mcp-discard-description" className="mt-3 scroll-my-1 rounded-lg border border-outline-variant bg-surface p-4">
    <h3 id="mcp-discard-heading" className="font-semibold">Discard unsaved changes?</h3>
    <p id="mcp-discard-description" className="mt-1 break-words text-sm text-on-surface-variant">Keep editing {editedConnectionName}, or discard its changes to {decisionReason}.</p>
    <div className="mt-3 flex flex-wrap gap-2">
      <Button ref={keepEditingRef} type="button" className="min-h-10 focus:outline-none focus:ring-[3px] focus:ring-ring/50" onClick={() => { returnToEditor.current = true; setDecision(false); nextEditor.current = null; }}>Keep editing</Button>
      <Button type="button" variant="outline" className="min-h-10" onClick={() => { const next = nextEditor.current; nextEditor.current = null; discardFocus.current = { control: invokingControl.current, serverId: editingMcpServerId }; editorFocusRequested.current = true; setDecision(false); next?.(); }}>Discard changes</Button>
    </div>
  </div> : null;

  const form = showForm ? (
          <form
            ref={attachForm}
            data-editor-id={editingMcpServerId ?? ""}
            tabIndex={-1}
            aria-busy={saving}
            aria-describedby={localError ? "mcp-save-error" : undefined}
            aria-label={editingMcpServerId ? `Manage ${editedConnectionName}` : "Add connection"}
            onSubmit={(event) => void handleSubmit(event)}
            className="min-w-0 scroll-mt-1 rounded-lg bg-surface-container-low p-4 focus:outline-none focus:ring-[3px] focus:ring-ring/50 [&_button]:min-h-10 [&_input]:min-h-10 [&_[role=combobox]]:min-h-10"
          >
            <fieldset disabled={saving} className="flex min-w-0 flex-col gap-4">
            {inheritedServer ? <section aria-labelledby="mcp-built-in-heading" className="space-y-3">
              <h3 id="mcp-built-in-heading" className="font-semibold">Built-in connection</h3>
              <p className="text-sm text-on-surface-variant">The system manages these settings. You can change availability below.</p>
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <div className="min-w-0"><dt className="text-on-surface-variant">Name</dt><dd id="mcp-built-in-name" className="mt-1 break-words font-medium">{mcpDraft.serverName}</dd></div>
                <div className="min-w-0"><dt className="text-on-surface-variant">Description</dt><dd className="mt-1 break-words">{mcpDraft.description || "No description."}</dd></div>
              </dl>
            </section> : <section aria-labelledby="mcp-details-heading" className="space-y-4">
            <h3 id="mcp-details-heading" className="font-semibold">Connection details</h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mcp-server-name">Name</Label>
                <Input
                  id="mcp-server-name"
                  value={mcpDraft.serverName}
                  readOnly={Boolean(inheritedServer)}
                  onChange={(e) => setMcpDraft((current) => {
                    const serverName = e.target.value;
                    const serverId = current.customId
                      ? current.serverId
                      : deriveMcpServerId(serverName, props.mcpServers.map((server) => server.serverId));
                    return {
                      ...current,
                      serverName,
                      serverId,
                      routePath: current.customRoute ? current.routePath : `/mcp/${serverId}`
                    };
                  })}
                  placeholder="Research database"
                  required
                />
              </div>
              {mcpDraft.mode === "proxy" ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="mcp-upstream">URL</Label>
                  <Input
                    id="mcp-upstream"
                    type="url"
                    value={mcpDraft.upstreamUrl}
                    onChange={(e) => setMcpDraft((c) => ({ ...c, upstreamUrl: e.target.value }))}
                    placeholder="https://example.com/mcp"
                    required
                    readOnly={Boolean(inheritedServer)}
                  />
                  {upstreamWarnings.http ? <p role="status" className="text-sm text-warning">HTTP sends requests without encryption and can expose credentials.</p> : null}
                  {upstreamWarnings.privateNetwork ? <p role="status" className="text-sm text-warning">This address appears to be on a local or shared network. The backend will send requests to it.</p> : null}
                </div>
              ) : null}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mcp-description">Description</Label>
              <Textarea
                id="mcp-description"
                value={mcpDraft.description}
                onChange={(e) => setMcpDraft((c) => ({ ...c, description: e.target.value }))}
                placeholder="What can members do with this connection?"
                rows={2}
                readOnly={Boolean(inheritedServer)}
              />
            </div>

            <details className="rounded-md border border-outline-variant p-3">
              <summary className="cursor-pointer text-sm font-medium text-on-surface">Advanced settings</summary>
              <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="mcp-server-id">Server ID</Label>
                  <Input
                    id="mcp-server-id"
                    value={mcpDraft.serverId}
                    onChange={(e) => setMcpDraft((c) => ({ ...c, serverId: e.target.value, customId: true, routePath: c.customRoute ? c.routePath : `/mcp/${e.target.value}` }))}
                    disabled={Boolean(editingMcpServerId)}
                    required
                  />
                </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mcp-mode">Mode</Label>
                <Select
                  value={mcpDraft.mode}
                  disabled={saving || Boolean(inheritedServer)}
                  onValueChange={(v) =>
                    setMcpDraft((c) => ({ ...c, mode: v as McpDraft["mode"] }))
                  }
                >
                  <SelectTrigger id="mcp-mode" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="managed">Managed</SelectItem>
                    <SelectItem value="proxy">Proxy</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mcp-route">Route path</Label>
                <Input
                  id="mcp-route"
                  value={mcpDraft.routePath}
                  onChange={(e) => setMcpDraft((c) => ({ ...c, routePath: e.target.value, customRoute: true }))}
                  placeholder="/mcp/example"
                  required
                  readOnly={Boolean(inheritedServer)}
                />
              </div>
            </div>
            </details>
            </section>}

            {mcpDraft.mode === "proxy" && !inheritedServer ? (
              <section aria-labelledby="mcp-account-heading" className="space-y-4 border-t border-outline-variant pt-4">
                <h3 id="mcp-account-heading" className="font-semibold">Account and authentication</h3>
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">Account for this connection</legend>
                  <label className="flex min-h-10 items-center gap-2 text-sm"><input type="radio" name="mcp-credential-scope" checked={mcpDraft.credentialScope === "organization"} onChange={() => setMcpDraft((current) => ({ ...current, credentialScope: "organization", upstreamAuthSecret: "" }))} />Organization account</label>
                  <label className="flex min-h-10 items-center gap-2 text-sm"><input type="radio" name="mcp-credential-scope" checked={mcpDraft.credentialScope === "personal"} onChange={() => setMcpDraft((current) => ({ ...current, credentialScope: "personal", upstreamAuthSecret: "" }))} />Each member connects</label>
                  <p className="text-sm text-on-surface-variant">{mcpDraft.credentialScope === "personal"
                    ? "Members use their own credentials when this connection is available to them. Changing the URL or authentication method requires members to reconnect. This list does not confirm whether you or another member has connected."
                    : "Organization authentication settings apply to members who can use this connection."}</p>
                </fieldset>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="mcp-upstream-auth-type">Upstream authentication</Label>
                  <Select
                    value={mcpDraft.upstreamAuthType}
                    disabled={saving}
                    onValueChange={(value) =>
                      setMcpDraft((current) => ({
                        ...current,
                        upstreamAuthType: value as McpDraft["upstreamAuthType"],
                        upstreamAuthName:
                          value === "header" || value === "query"
                            ? current.upstreamAuthName
                            : "",
                        upstreamAuthSecret: value === "none" ? "" : current.upstreamAuthSecret
                      }))
                    }
                  >
                    <SelectTrigger id="mcp-upstream-auth-type" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      <SelectItem value="bearer">Bearer token</SelectItem>
                      <SelectItem value="header">Custom header</SelectItem>
                      <SelectItem value="query">Query parameter</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {mcpDraft.upstreamAuthType === "header" ||
                mcpDraft.upstreamAuthType === "query" ? (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="mcp-upstream-auth-name">
                      {mcpDraft.upstreamAuthType === "header" ? "Header name" : "Parameter name"}
                    </Label>
                    <Input
                      id="mcp-upstream-auth-name"
                      value={mcpDraft.upstreamAuthName}
                      onChange={(event) =>
                        setMcpDraft((current) => ({
                          ...current,
                          upstreamAuthName: event.target.value
                        }))
                      }
                      placeholder={mcpDraft.upstreamAuthType === "header" ? "X-API-Key" : "api_key"}
                    />
                  </div>
                ) : null}

                {mcpDraft.credentialScope === "organization" && mcpDraft.upstreamAuthType !== "none" ? (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="mcp-upstream-auth-secret">Secret</Label>
                    <Input
                      id="mcp-upstream-auth-secret"
                      type="password"
                      autoComplete="new-password"
                      aria-describedby="mcp-secret-hint"
                      value={mcpDraft.upstreamAuthSecret}
                      onChange={(event) =>
                        setMcpDraft((current) => ({
                          ...current,
                          upstreamAuthSecret: event.target.value
                        }))
                      }
                      placeholder="Upstream credential"
                    />
                    <p id="mcp-secret-hint" className="text-sm text-on-surface-variant">{props.mcpServers.some(server => server.serverId === editingMcpServerId && server.credentialScope === "organization" && server.upstreamAuthConfigured)
                      ? "Leave blank to keep the saved secret."
                      : "Enter the upstream credential."}</p>
                  </div>
                ) : null}
                </div>
                {mcpDraft.credentialScope === "personal" && mcpDraft.upstreamAuthType === "none" ? <p className="text-sm text-on-surface-variant">Choose bearer token, header, or query authentication so each member can connect.</p> : null}
              </section>
            ) : null}

            <section aria-labelledby="mcp-availability-heading" className="space-y-3 border-t border-outline-variant pt-4">
              <h3 id="mcp-availability-heading" className="font-semibold">Member access</h3>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mcp-audience">Availability</Label>
                <Select value={mcpDraft.audience} disabled={saving} onValueChange={(value) => setMcpDraft((current) => ({ ...current, audience: value as McpAudience }))}>
                  <SelectTrigger id="mcp-audience" className="w-56"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="off">Off</SelectItem>
                    {!inheritedServer || !inheritedServer.isPublished ? <SelectItem value="test_users">Test users</SelectItem> : null}
                    {!inheritedServer || inheritedServer.isPublished ? <SelectItem value="members">All members</SelectItem> : null}
                  </SelectContent>
                </Select>
                <p className="text-sm text-on-surface-variant">
                  {inheritedServer
                    ? "Choose whether members can use this built-in connection."
                    : "Test users can use this before it is available to all members."}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="ghost" onClick={() => requestEditorChange(handleCancel, "close this editor")}>
                  Cancel
                </Button>
                <Button type="submit" disabled={Boolean(editingMcpServerId && !props.mcpServers.some(server => server.serverId === editingMcpServerId)) || props.busyKey === "mcp" || (mcpDraft.mode === "proxy" && mcpDraft.credentialScope === "personal" && mcpDraft.upstreamAuthType === "none") || (mcpDraft.mode === "proxy" && mcpDraft.credentialScope === "organization" && mcpDraft.upstreamAuthType !== "none" && !mcpDraft.upstreamAuthSecret && (!editingMcpServerId || props.mcpServers.find((server) => server.serverId === editingMcpServerId)?.credentialScope === "personal"))}>
                  {saving ? "Saving connection…" : inheritedServer ? "Save availability" : editingMcpServerId ? "Save connection" : "Add connection"}
                </Button>
              </div>
            </div>
            </section>
            </fieldset>
            {decisionAnchor === "form" ? discardDecision : null}
            <p id="mcp-save-error" ref={errorRef} tabIndex={-1} role={localError ? "alert" : "status"} className={`mt-3 text-sm ${MCP_TEXT_FOCUS} ${localError ? "text-danger" : "text-on-surface-variant"}`}>
              {saving ? "Saving this connection. Wait before editing or opening another connection." : localError || "Changes apply only after you submit this form."}
            </p>
          </form>
  ) : null;
  const targetMissing = props.listReady !== false && Boolean(props.targetServerId) && !props.mcpServers.some((server) => server.serverId === props.targetServerId);

  return (
    <section aria-labelledby="mcp-heading" className="[&_button]:min-h-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 ref={headingRef} id="mcp-heading" tabIndex={-1} className={`text-lg font-semibold text-on-surface ${MCP_TEXT_FOCUS}`}>MCP connections</h2>
        <Button
          ref={addButton}
          type="button"
          variant="outline"
          size="sm"
          className={showForm && !editingMcpServerId ? "hidden" : "min-h-10"}
          disabled={props.listReady === false || saving || props.busyKey !== null}
          aria-expanded={showForm && !editingMcpServerId}
          aria-controls="mcp-add-form"
          onClick={() => requestEditorChange(() => {
            const opening = !(showForm && !editingMcpServerId);
            handleCancel();
            setShowForm(opening);
            setExpandedId(null);
          }, showForm && !editingMcpServerId ? "close this editor" : "open a new connection", "header")}
        >
          Add connection
        </Button>
      </div>
      {decisionAnchor === "header" ? discardDecision : null}
      {props.listNotice}
      {targetMissing && !editorMissing ? <p role="alert" className="mt-2 text-sm text-on-surface-variant">This connection is no longer available. Choose a connection below.</p> : null}
      {editorMissing ? <div className="mt-4"><div className="mb-3 flex flex-wrap items-center gap-3"><p role="alert" className="text-sm text-warning">This connection is absent from the latest list. Your draft is kept. Reload the list to check again.</p>{props.onReload ? <Button type="button" variant="outline" aria-disabled={reloading} onClick={event => void reloadConnections(event.currentTarget)}>{reloading ? "Reloading connections…" : "Reload connections"}</Button> : null}</div>{reloadError ? <p role="alert" className="mb-3 text-sm text-danger">{reloadError}</p> : null}{form}</div> : null}
      <div id="mcp-add-form" hidden={!(showForm && !editingMcpServerId)} className="mt-4">{showForm && !editingMcpServerId ? form : null}</div>

      <div className={props.listReady === false ? "hidden" : "mt-2 divide-y divide-outline-variant border-t border-outline-variant"}>
        {props.mcpServers.length === 0 ? <p className="py-4 text-sm text-on-surface-variant">No connections yet.</p> : null}
        {props.mcpServers.map((server) => {
          const availability = getMcpAvailability(server);
          const editing = showForm && editingMcpServerId === server.serverId;
          const unsavedChanges = editing && (dirty || saving);
          const check = server.connectionTest;
          const tested = check && check.configVersion === server.version && check.configHash === server.configHash
            && (server.credentialScope !== "personal" || check.testedUserId === user?.userId);
          return (
            <div key={server.serverId}>
            {typeof decisionAnchor === "object" && decisionAnchor.serverId === server.serverId ? discardDecision : null}
            <DisclosureRow
              title={server.serverName}
              status={<>{availability.label}.{availability.blocker ? <span className="text-warning"> {availability.blocker}</span> : null}{" "}
                {tested ? `Last test: ${reachabilityLabel[check.reachability].toLowerCase()}.` : "Not tested since the last save."}</>}
              action="Manage"
              actionLabel={`Manage ${server.serverName}`}
              buttonRef={(button) => { if (button) manageButtons.current.set(server.serverId, button); else manageButtons.current.delete(server.serverId); }}
              open={expandedId === server.serverId}
              disabled={saving || props.busyKey !== null}
              onOpenChange={(next) => requestEditorChange(() => {
                if (next) { setExpandedId(server.serverId); handleEdit(server); }
                else { setExpandedId(null); if (editing) handleCancel(); }
              }, next ? `open ${server.serverName}` : "close this editor", { serverId: server.serverId })}
            >
              {editing ? form : <Button type="button" variant="outline" size="sm" className="min-h-10 self-start" onClick={() => requestEditorChange(() => handleEdit(server), `open settings for ${server.serverName}`, { serverId: server.serverId })} disabled={saving || props.busyKey !== null}>Edit settings</Button>}
              <div className="flex flex-wrap gap-2 text-xs text-on-surface-variant">
                <span className={CHIP}>ID {server.serverId}</span>
                <span className={CHIP}>route {server.routePath}</span>
                <span className={CHIP}>version {server.version}</span>
                <span className={CHIP}>{server.mode} · {server.transportKind}</span>
                <span className={CHIP}>authentication {server.credentialScope === "personal" || server.upstreamAuthConfigured ? server.upstreamAuthType : "none"}</span>
                {server.mode === "proxy" ? <span className={CHIP}>{server.credentialScope === "personal" ? "Each member connects" : "Organization account"}</span> : null}
              </div>
              <div aria-label="Usage in the last 30 days" className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-on-surface-variant">
                <p title="Distinct sessions in the last 30 days where this server received a tool call.">{typeof server.invokedSessions30d === "number" ? `Used in ${server.invokedSessions30d} ${server.invokedSessions30d === 1 ? "session" : "sessions"}` : "Usage unavailable"}</p>
                <p title="Distinct sessions in the last 30 days where this server was offered to the agent.">{typeof server.materializedSessions30d === "number" ? `Offered in ${server.materializedSessions30d} ${server.materializedSessions30d === 1 ? "session" : "sessions"}` : "Offer count unavailable"}</p>
              </div>
              <AdminMcpConnectionTestCard key={`${server.serverId}:${server.version}:${server.configHash}`} server={server} listGeneration={props.listGeneration ?? 0} unsavedChanges={unsavedChanges} onTested={props.onTested} onReload={props.onReload} />
              {props.renderServerExtras?.(server, expandedId === server.serverId)}
            </DisclosureRow>
            </div>
          );
        })}
      </div>
    </section>
  );
}
