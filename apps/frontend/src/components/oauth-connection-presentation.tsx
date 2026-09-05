import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import type { OAuthConnectionBusyKey } from "../hooks/use-oauth-connection";
import { HINT, SECTION_LABEL } from "../lib/ui-tokens";

export function OAuthConnectionSectionHeading(input: { provider: string }) {
  return (
    <div>
      <p className={SECTION_LABEL}>Live module</p>
      <h3 className="text-lg font-semibold text-on-surface">{input.provider}</h3>
    </div>
  );
}

export function OAuthConnectionActions(input: {
  busyKey: OAuthConnectionBusyKey | null;
  configured: boolean;
  connected: boolean;
  connectLabel: string;
  reconnectLabel: string;
  error: string | null;
  flashMessage: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
  children: ReactNode;
}) {
  const connectLabel =
    input.busyKey === "connect"
      ? "Redirecting..."
      : input.connected
        ? input.reconnectLabel
        : input.connectLabel;

  return (
    <>
      {input.flashMessage ? <p className={HINT}>{input.flashMessage}</p> : null}
      {input.error ? <p className="text-sm text-danger">{input.error}</p> : null}
      {input.children}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          disabled={!input.configured || input.busyKey !== null}
          onClick={input.onConnect}
        >
          {connectLabel}
        </Button>
        {input.connected ? (
          <Button
            type="button"
            variant="ghost"
            disabled={input.busyKey !== null}
            onClick={input.onDisconnect}
          >
            {input.busyKey === "disconnect" ? "Disconnecting..." : "Disconnect"}
          </Button>
        ) : null}
      </div>
    </>
  );
}
