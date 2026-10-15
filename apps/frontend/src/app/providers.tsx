"use client";

import { ReactNode } from "react";

import { AuthProvider } from "../lib/auth-context";
import { KeyboardShortcutsDialog } from "../components/keyboard-shortcuts-dialog";
import { Toaster } from "../components/ui/sonner";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      {children}
      <KeyboardShortcutsDialog />
      {/* Global toast surface — artifact-browser (and future callers) use
          toast()/toast.error(); without this mount those notifications would
          silently go nowhere. */}
      <Toaster position="bottom-right" richColors />
    </AuthProvider>
  );
}
