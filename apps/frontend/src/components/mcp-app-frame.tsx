"use client";

import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { McpAppCall } from "@cogniplane/shared-types";
import { useEffect, useRef, useState } from "react";

import { fetchWithAuthRetry } from "../lib/api-client";
import { OriginBoundPostMessageTransport } from "../lib/mcp-app-origin-transport";
import { mcpAppSandboxOrigin } from "../lib/mcp-app-sandbox-origin";
import { checkAppUserMessage, refusedMessageText } from "./mcp-app-frame.logic";
import { Button } from "./ui/button";
import { widgetSourceLabel } from "./widget-draft.logic";
import type { WidgetDraftSeam } from "./widget-draft";

type AppResource = {
  uri: string;
  mimeType: string;
  text: string;
  _meta?: { ui?: { csp?: Record<string, unknown> } };
};
type AppMessageResponse = { isError?: boolean };

function sandboxUrl(): string | null {
  const origin = mcpAppSandboxOrigin(window.location.origin);
  return origin ? new URL("/mcp-app-sandbox.html", origin).href : null;
}

function isAppResource(value: unknown, uri: string): value is AppResource {
  if (!value || typeof value !== "object") return false;
  const resource = value as Partial<AppResource>;
  return resource.uri === uri && typeof resource.mimeType === "string" &&
    resource.mimeType.toLowerCase().startsWith("text/html") && typeof resource.text === "string";
}

// A tool view never sends a message. `ui/message` puts the text in the message
// box as a draft (see widget-draft.tsx). The user reads it and sends it with the
// normal Send button. The answer to the tool view means: `{}` the draft is in
// the box, `{ isError: true }` it is not. It never says whether the user sends.
export function McpAppFrame({ sessionId, toolCallId, toolName, app, draft, canEdit, busy }: {
  sessionId: string;
  toolCallId: string;
  /** The tool that made this view. The notice by the message box names it. */
  toolName: string;
  app: McpAppCall;
  draft: WidgetDraftSeam;
  canEdit: boolean;
  busy: boolean;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const canEditRef = useRef(canEdit);
  const busyRef = useRef(busy);
  const draftRef = useRef(draft);
  const source = widgetSourceLabel(toolName, app.resourceUri);
  const sourceRef = useRef(source);
  // A request that waits for the user, because the box already holds a draft.
  const pendingRequestRef = useRef<{ text: string; resolve: (result: AppMessageResponse) => void } | null>(null);
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [messageError, setMessageError] = useState<string | null>(null);
  const [resource, setResource] = useState<AppResource | null>(null);
  const [input, setInput] = useState<Record<string, unknown>>({});
  const [result, setResult] = useState<McpAppCall["result"] | null>(null);
  const [height, setHeight] = useState(560);
  const [error, setError] = useState<string | null>(null);
  const frameUrl = sandboxUrl();

  useEffect(() => {
    canEditRef.current = canEdit;
    busyRef.current = busy;
    draftRef.current = draft;
    sourceRef.current = source;
  }, [canEdit, busy, draft, source]);

  useEffect(() => {
    if (!frameUrl) return;
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetchWithAuthRetry(
          `/sessions/${encodeURIComponent(sessionId)}/mcp-apps/${encodeURIComponent(toolCallId)}`,
          { signal: controller.signal }
        );
        if (!response.ok) throw new Error(`Resource request failed (HTTP ${response.status}).`);
        const body: unknown = await response.json();
        if (!body || typeof body !== "object") throw new Error("The server returned an invalid tool view.");
        const value = body as { resource?: unknown; input?: unknown; result?: unknown };
        if (!isAppResource(value.resource, app.resourceUri) || !value.result || typeof value.result !== "object" ||
            !value.input || typeof value.input !== "object" || Array.isArray(value.input)) {
          throw new Error("The server returned an invalid tool view.");
        }
        setResource(value.resource);
        setInput(value.input as Record<string, unknown>);
        setResult(value.result as McpAppCall["result"]);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "The tool view could not load.");
      }
    };
    void load();
    return () => {
      controller.abort();
    };
  }, [sessionId, toolCallId, app.resourceUri, frameUrl]);

  useEffect(() => {
    const iframe = iframeRef.current;
    const frameWindow = iframe?.contentWindow;
    if (!frameUrl || !resource || !result || !iframe || !frameWindow) return;
    let closed = false;
    const theme = () => document.documentElement.dataset.theme === "dark" ? "dark" as const : "light" as const;
    const bridge = new AppBridge(null, { name: "Cogniplane", version: "0.1.0" }, {}, {
      hostContext: { theme: theme() }
    });
    const themeObserver = new MutationObserver(() => bridge.setHostContext({ theme: theme() }));
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    bridge.onsandboxready = () => {
      if (!closed) void bridge.sendSandboxResourceReady({
        html: resource.text,
        csp: resource._meta?.ui?.csp as Parameters<typeof bridge.sendSandboxResourceReady>[0]["csp"]
      }).catch(() => setError("The tool view could not start."));
    };
    bridge.oninitialized = () => {
      if (closed) return;
      void (async () => {
        await bridge.sendToolInput({ arguments: input });
        await bridge.sendToolResult(result as Parameters<typeof bridge.sendToolResult>[0]);
      })().catch(() => setError("The tool view could not receive its data."));
    };
    bridge.onsizechange = ({ height: requestedHeight }) => {
      if (typeof requestedHeight === "number" && Number.isFinite(requestedHeight)) {
        setHeight(Math.max(280, Math.min(900, requestedHeight)));
      }
    };
    bridge.onmessage = async ({ role, content }) => {
      const check = checkAppUserMessage(role, content, canEditRef.current, busyRef.current);
      if (!check.ok) {
        const refusal = refusedMessageText(check);
        if (refusal) setMessageError(refusal);
        return { isError: true };
      }
      if (pendingRequestRef.current) return { isError: true };
      const placement = draftRef.current.place({ text: check.text, source: sourceRef.current, append: false });
      if (placement === "placed") {
        setMessageError(null);
        return {};
      }
      if (placement === "unavailable") return { isError: true };
      // The box holds a draft of the user. Do not touch it. Ask first.
      return new Promise<AppMessageResponse>((resolve) => {
        pendingRequestRef.current = { text: check.text, resolve };
        setPendingText(check.text);
      });
    };
    // The bridge reads messages only from the sandbox window at the sandbox
    // origin, and it sends only to that origin.
    const sandboxOrigin = new URL(frameUrl).origin;
    void (async () => {
      await bridge.connect(new OriginBoundPostMessageTransport(frameWindow, sandboxOrigin));
      if (!closed) iframe.src = frameUrl;
    })().catch(() => setError("The tool view could not connect."));
    return () => {
      closed = true;
      themeObserver.disconnect();
      pendingRequestRef.current?.resolve({ isError: true });
      pendingRequestRef.current = null;
      setPendingText(null);
      void bridge.close();
      iframe.removeAttribute("src");
    };
  }, [frameUrl, input, resource, result]);

  const dismissWaitingMessage = () => {
    const pending = pendingRequestRef.current;
    pendingRequestRef.current = null;
    setPendingText(null);
    pending?.resolve({ isError: true });
  };

  // Puts the text after the draft of the user. The user still reads it and
  // sends it from the message box.
  const addWaitingMessage = () => {
    const pending = pendingRequestRef.current;
    if (!pending) return;
    pendingRequestRef.current = null;
    setPendingText(null);
    if (!canEditRef.current || busyRef.current) {
      pending.resolve({ isError: true });
      return;
    }
    const placement = draftRef.current.place({ text: pending.text, source: sourceRef.current, append: true });
    pending.resolve(placement === "placed" ? {} : { isError: true });
  };

  if (!frameUrl) return <p role="alert" className="text-sm text-on-surface-variant">Interactive tool views need a separate sandbox origin.</p>;
  if (error) return <p role="alert" className="text-sm text-danger">{error}</p>;
  return (
    <div className="my-2 overflow-hidden rounded-md border border-outline-variant bg-surface-container-low">
      {resource ? (
        <iframe
          ref={iframeRef}
          title="Interactive tool view"
          sandbox="allow-scripts allow-same-origin"
          referrerPolicy="no-referrer"
          className="block w-full"
          style={{ height }}
        />
      ) : <p role="status" className="p-4 text-sm text-on-surface-variant">Loading tool view…</p>}
      {pendingText !== null && (
        <div role="group" aria-label="Tool view message waiting" className="border-t border-outline-variant p-4">
          <p className="text-sm font-medium">This tool view wants to add text to your message box.</p>
          <p className="mt-1 text-sm text-on-surface-variant">
            You already have a draft, so nothing changed yet. If you add the text, it goes after your draft
            ({pendingText.length.toLocaleString("en-US")} characters). You read it and change it in the message box.
            Nothing is sent until you press Send.
          </p>
          <div className="mt-3 flex gap-2">
            <Button type="button" size="sm" onClick={addWaitingMessage} disabled={!canEdit || busy}>Add after my draft</Button>
            <Button type="button" size="sm" variant="outline" onClick={dismissWaitingMessage}>Dismiss</Button>
          </div>
        </div>
      )}
      {messageError !== null && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 border-t border-outline-variant p-3 text-sm text-danger">
          <p>{messageError}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => setMessageError(null)}>Dismiss</Button>
        </div>
      )}
    </div>
  );
}
