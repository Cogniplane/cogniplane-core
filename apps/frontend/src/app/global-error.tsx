"use client";

// Replaces the root layout when the layout itself throws. It renders its own
// document with no app providers, so it uses no auth, query or toast state.

import { useSyncExternalStore } from "react";

import "./globals.css";
import { AppErrorNotice } from "../components/app-error-notice";
import { readSavedTheme } from "../lib/theme";

const noSubscription = () => () => undefined;

export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  // React removes the <html> attributes that theme-init.js set. The server
  // render has no storage, so it uses light; the client applies the saved theme.
  const theme = useSyncExternalStore(noSubscription, readSavedTheme, () => "light" as const);
  return (
    <html lang="en" data-theme={theme === "dark" ? "dark" : undefined}>
      <body>
        <title>Cogniplane</title>
        <AppErrorNotice error={error} onRetry={retry} />
      </body>
    </html>
  );
}
