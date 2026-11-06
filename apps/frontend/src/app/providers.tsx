"use client";

import { ReactNode } from "react";

import { AuthProvider } from "../lib/auth-context";
import { KeyboardShortcutsDialog } from "../components/keyboard-shortcuts-dialog";
import { StepUpHost } from "../components/step-up-host";
import { Toaster } from "../components/ui/sonner";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      {children}
      <KeyboardShortcutsDialog />
      {/* Asks for a fresh proof when the backend refuses a sensitive change
          with a step-up action, then sends the same request again. */}
      <StepUpHost />
      {/* Global toast surface — artifact-browser (and future callers) use
          toast()/toast.error(); without this mount those notifications would
          silently go nowhere. */}
      <Toaster position="bottom-right" richColors />
    </AuthProvider>
  );
}
