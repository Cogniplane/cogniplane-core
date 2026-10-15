"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import type { TenantSettings } from "@cogniplane/shared-types";
import type { FormDraft } from "./tenant-settings-form.logic";

type BehaviorDraft = { baseline: TenantSettings; draft: FormDraft };
type DraftStore = {
  read: () => BehaviorDraft | null;
  write: (draft: BehaviorDraft | null) => void;
};

const DraftContext = createContext<DraftStore | null>(null);

/** Kept in memory across navigation. The auth boundary resets it when identity changes. */
export function AgentBehaviorDraftProvider({ children }: { children: ReactNode }) {
  const [store] = useState<DraftStore>(() => {
    let current: BehaviorDraft | null = null;
    return { read: () => current, write: (draft) => { current = draft; } };
  });
  return <DraftContext.Provider value={store}>{children}</DraftContext.Provider>;
}

export function useAgentBehaviorDraftStore() {
  return useContext(DraftContext);
}
