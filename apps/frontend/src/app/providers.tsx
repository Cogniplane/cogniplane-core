"use client";

import { ReactNode } from "react";

import { AuthProvider } from "../lib/auth-context";
import { Toaster } from "../components/ui/sonner";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      {children}
      {/* Global toast surface — artifact-browser (and future callers) use
          toast()/toast.error(); without this mount those notifications would
          silently go nowhere. */}
      <Toaster position="bottom-right" richColors />
    </AuthProvider>
  );
}
