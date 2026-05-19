"use client";

import { useCallback, useState } from "react";

import { createMessageArtifact } from "../lib/artifact-api";
import type { Message } from "@cogniplane/shared-types";

export function useMessageExport(input: {
  selectedSessionId: string | null;
  refreshSessionData: (sessionId: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const { selectedSessionId, refreshSessionData, onError } = input;

  const [exportMessageId, setExportMessageId] = useState<string | null>(null);

  const handleExportMessage = useCallback(
    async (message: Message) => {
      try {
        setExportMessageId(message.messageId);
        await createMessageArtifact(message.messageId);
        if (selectedSessionId) {
          await refreshSessionData(selectedSessionId);
        }
      } catch (caughtError) {
        onError(caughtError instanceof Error ? caughtError.message : String(caughtError));
      } finally {
        setExportMessageId(null);
      }
    },
    [selectedSessionId, refreshSessionData, onError]
  );

  return {
    exportMessageId,
    handleExportMessage
  };
}
