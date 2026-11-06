"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { AuthStepHeading } from "./auth-frame";
import { AUTH_FOCUS_RING, AuthMessage, PendingButton, usePendingAction } from "./auth-ui";

export const copyRecoveryCodes = (text: string) => navigator.clipboard.writeText(text);
export function downloadRecoveryCodes(text: string) {
  const url = URL.createObjectURL(new Blob([`Cogniplane recovery codes\n\n${text}\n`], { type: "text/plain" }));
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = "cogniplane-recovery-codes.txt";
    link.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

// After a failure, suggest only the ways to save that have not failed yet.
function saveFailureMessage(failed: "copy" | "download", other: boolean) {
  if (failed === "copy") return other ? "Copy did not work. Select the codes and copy them, or write them down." : "Copy did not work. Select and copy the codes, or download them.";
  return other ? "Download did not work. Select the codes and copy them, or write them down." : "Download did not work. Use Copy codes, or select and copy the codes.";
}

// The backend keeps only hashes. Keep this one display until the person saves it.
export function RecoveryCodesPanel({ codes, onDone, doneLabel = "I saved my codes", copyCodes = copyRecoveryCodes, downloadCodes = downloadRecoveryCodes }: {
  codes: string[];
  onDone: () => Promise<void> | void;
  doneLabel?: string;
  copyCodes?: (text: string) => Promise<void>;
  downloadCodes?: (text: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ copy: boolean; download: boolean }>({ copy: false, download: false });
  const [completionError, setCompletionError] = useState<string | null>(null);
  const completionErrorId = useId();
  const { pending, busy, run } = usePendingAction<"copy" | "done">();
  const text = codes.join("\n");

  const copy = () => run("copy", async () => {
    setSaveError(null);
    setCopied(false);
    try {
      await copyCodes(text);
      setCopied(true);
    } catch {
      setFailed(value => ({ ...value, copy: true }));
      setSaveError(saveFailureMessage("copy", failed.download));
    }
  });

  const download = () => {
    if (busy) return;
    setSaveError(null);
    setCopied(false);
    try {
      downloadCodes(text);
    } catch {
      setFailed(value => ({ ...value, download: true }));
      setSaveError(saveFailureMessage("download", failed.copy));
    }
  };

  const finish = () => run("done", async () => {
    setCompletionError(null);
    try {
      await onDone();
    } catch {
      setCompletionError("We could not continue. Keep your saved codes and try this action again.");
    }
  });

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <AuthStepHeading>Save your recovery codes</AuthStepHeading>
      <p className="text-sm text-on-surface-variant">Save these codes in a safe place. Each code lets you sign in once if you lose access to your second step. You cannot see them again.</p>
      <ul aria-label="Recovery codes" tabIndex={0} className={cn("grid select-text grid-cols-1 gap-x-3 gap-y-2 rounded-md bg-surface-container-low p-3 font-mono text-sm text-on-surface sm:grid-cols-2", AUTH_FOCUS_RING)}>
        {codes.map(code => <li key={code} className="[overflow-wrap:anywhere]">{code}</li>)}
      </ul>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          <PendingButton type="button" variant="outline" pending={pending === "copy"} pendingLabel="Copying…" disabled={pending === "done"} onClick={() => void copy()}>Copy codes</PendingButton>
          <Button type="button" variant="outline" disabled={busy} onClick={download}>Download</Button>
        </div>
        {copied ? <AuthMessage tone="success">Copied.</AuthMessage> : null}
        {saveError ? <AuthMessage tone="error">{saveError}</AuthMessage> : null}
      </div>
      <div className="mt-1 flex flex-col gap-3 border-t border-outline-variant pt-4">
        <p className="text-xs text-on-surface-variant">Continue after you save the codes in your password manager or another safe place.</p>
        <PendingButton type="button" pending={pending === "done"} pendingLabel="Continuing…" disabled={pending === "copy"} aria-describedby={completionError ? completionErrorId : undefined} onClick={() => void finish()}>{doneLabel}</PendingButton>
        {completionError ? <AuthMessage id={completionErrorId} tone="error">{completionError}</AuthMessage> : null}
        {pending === "done" ? <AuthMessage tone="note">Please wait while we continue…</AuthMessage> : null}
      </div>
    </div>
  );
}
