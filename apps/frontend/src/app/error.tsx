"use client";

// The error page of every route that has no error page of its own. Next.js
// shows it in place of the page when the page throws while it renders; the
// root layout and its providers stay mounted, but this page uses none of them.
// Errors in the root layout go to global-error.tsx.

import { AppErrorNotice } from "../components/app-error-notice";

export default function RouteError({ error, retry }: { error: unknown; retry: () => void }) {
  return <AppErrorNotice error={error} onRetry={retry} />;
}
