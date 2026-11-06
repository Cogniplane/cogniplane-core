"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import type { EnrollmentCompleteResponse, TotpEnrollmentResponse } from "@cogniplane/shared-types";

import { AuthStepHeading } from "./auth-frame";
import { AUTH_FOCUS_RING, AuthDisclosure, AuthMessage, PendingButton, pendingFieldProps, usePendingAction } from "./auth-ui";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/cn";
import { localAuthErrorCode, localAuthMessage } from "../../lib/local-auth-api";
import { TotpQr } from "./totp-qr";

// A failed start has no retry here: a second start would replace the pending
// secret and spend the step-up again. The message names the cause only; the
// caller offers the next step (Start again, or Cancel in settings).
function startFailureMessage(caught: unknown): string {
  const code = localAuthErrorCode(caught);
  if (code === "network_error") return "The setup could not start because the server cannot be reached.";
  if (code === "sign_in_expired" || code === "step_up_required" || code === "session_changed") return localAuthMessage(caught, "The setup could not start.");
  return "The setup could not start.";
}

// Adds an authenticator app: scan the QR code (or type the key), then enter a
// code to prove it works. Used during sign-in and in Settings.
export function TotpEnrollment(props: {
  start: () => Promise<TotpEnrollmentResponse>;
  confirm: (code: string) => Promise<EnrollmentCompleteResponse>;
  onConfirmed: (result: EnrollmentCompleteResponse) => void;
  intro?: string;
  /** The next step after a failed start, shown under the reason. */
  restartHint?: string;
  onPendingChange?: (pending: boolean) => void;
  onStartFailed?: (failed: boolean) => void;
}) {
  const codeId = useId();
  const errorId = useId();
  const keyLabelId = useId();
  const { start } = props;
  const [enrollment, setEnrollment] = useState<TotpEnrollmentResponse | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const { busy: pending, run } = usePendingAction<"confirm">();
  const [invalidCode, setInvalidCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One start per `start` function. Strict Mode runs the effect twice; a
  // second call would replace the pending secret and spend the step-up token
  // again.
  const started = useRef<{ start: () => Promise<TotpEnrollmentResponse>; promise: Promise<TotpEnrollmentResponse> } | null>(null);

  // The parent learns that the start failed in the same update as this view,
  // so its restart or Cancel becomes primary without a one-frame lag. A start
  // that is still running does not lock the parent's exits: the request has
  // no timeout, and leaving only ignores its late result.
  const { onPendingChange, onStartFailed } = props;
  const report = useRef(onStartFailed);
  useLayoutEffect(() => { report.current = onStartFailed; });

  useEffect(() => {
    let cancelled = false;
    if (started.current?.start !== start) started.current = { start, promise: start() };
    started.current.promise.then(
      (result) => {
        if (cancelled) return;
        setStartError(null);
        setEnrollment(result);
      },
      (caught: unknown) => {
        if (cancelled) return;
        setStartError(startFailureMessage(caught));
        report.current?.(true);
      }
    );
    return () => { cancelled = true; };
  }, [start]);

  useEffect(() => { onPendingChange?.(pending); }, [onPendingChange, pending]);
  useEffect(() => { onStartFailed?.(startError !== null); }, [onStartFailed, startError]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run("confirm", async () => {
      onPendingChange?.(true);
      setError(null);
      setInvalidCode(false);
      try {
        props.onConfirmed(await props.confirm(code.trim()));
      } catch (caught) {
        setInvalidCode(localAuthErrorCode(caught) === "invalid_code");
        setError(localAuthMessage(caught, "The code could not be checked. Try again."));
      }
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <AuthStepHeading>Set up an authenticator app</AuthStepHeading>
      {!enrollment ? startError ? (
        <div className="flex flex-col gap-2">
          <AuthMessage tone="error">{startError}</AuthMessage>
          <p className="text-sm text-on-surface-variant">{props.restartHint ?? "Cancel this setup, then start it again."}</p>
        </div>
      ) : <AuthMessage tone="progress">Preparing your QR code…</AuthMessage> : (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <p className="text-sm text-on-surface-variant">
            {props.intro ?? "Scan this QR code with an authenticator app, such as Google Authenticator, Microsoft Authenticator, or 1Password."}
          </p>
          <TotpQr uri={enrollment.otpauthUri} />
          <AuthDisclosure summary="Cannot scan? Type this key">
            <div className="mt-3 flex flex-col gap-1">
              <p id={keyLabelId} className="text-xs font-medium text-on-surface-variant">Setup key</p>
              {/* A named group: a paragraph cannot carry a name. Focusable, so a keyboard user can reach and select it. */}
              <div role="group" aria-labelledby={keyLabelId} tabIndex={0} className={cn("select-text break-normal rounded-md bg-surface-container-low px-3 py-2 font-mono text-sm text-on-surface", AUTH_FOCUS_RING)}>
                {enrollment.secret.replace(/(.{4})/g, "$1 ").trim()}
              </div>
            </div>
          </AuthDisclosure>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={codeId}>Code from the app</Label>
            <Input
              id={codeId}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]*"
              maxLength={8}
              required
              {...pendingFieldProps(pending)}
              aria-invalid={invalidCode ? true : undefined}
              aria-describedby={invalidCode ? errorId : undefined}
              value={code}
              onChange={(e) => { if (!pending) setCode(e.target.value); }}
            />
            {error && invalidCode ? <AuthMessage tone="error" id={errorId}>{error}</AuthMessage> : null}
          </div>
          <PendingButton type="submit" pending={pending} pendingLabel="Checking…" aria-describedby={error && !invalidCode ? errorId : undefined}>Turn on two-step verification</PendingButton>
          {error && !invalidCode ? <AuthMessage id={errorId} tone="error">{error}</AuthMessage> : null}
          {pending ? <AuthMessage tone="note">Checking the code. Please wait…</AuthMessage> : null}
        </form>
      )}
    </div>
  );
}
