// The two chat hooks, wired as the chat host wires them, around a real
// DeepAgentsBrowserAgent. Tests drive the agent through @ag-ui/client with
// stubbed responses. copilot-chat-host.test.tsx covers the same wiring inside
// CopilotKit.
import { renderHook } from "@testing-library/react";
import { vi, type Mock } from "vitest";
import type { Approval } from "@cogniplane/shared-types";

import type { DeepAgentsBrowserAgent } from "../lib/agui/deep-agents-browser-agent";
import { useAguiCustomEvents } from "../lib/agui/use-agui-custom-events";
import { useSessionConnection } from "../lib/agui/use-session-connection";
import { savedState } from "./saved-side-state";

export function renderSessionHooks(
  agent: DeepAgentsBrowserAgent,
  options: { savedApprovals?: Approval[]; serverRunning?: boolean } = {}
) {
  const onTurnSettled: Mock<() => void> = vi.fn();
  const saved = options.savedApprovals ? savedState({ approvals: options.savedApprovals }) : undefined;
  // A test that needs a real connection replaces this.
  const connect: Mock<() => Promise<undefined>> = vi.fn(async () => undefined);
  // `rerender({ serverRunning })` changes the running state of the session list.
  const view = renderHook(({ serverRunning }: { serverRunning: boolean }) => {
    const events = useAguiCustomEvents(agent, { saved });
    const connection = useSessionConnection(agent, {
      sessionId: agent.threadId,
      serverRunning,
      connect,
      onTurnSettled,
      onTurnEnded: events.clearApprovals,
      onSendRefused: events.addNotice,
      onRemoteSnapshot: events.syncServerState
    });
    return { events, connection };
  }, { initialProps: { serverRunning: options.serverRunning ?? false } });
  return { ...view, onTurnSettled, connect };
}
