"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import type { AuthSessionResponse, NextStepResponse } from "@cogniplane/shared-types";

import { AuthStepHeading } from "./auth-frame";
import { authFlowActions, type AuthFlowActions } from "./auth-flow-actions";
import { AuthAlternatives, AuthMessage, PendingButton, pendingFieldProps, usePendingAction } from "./auth-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { localAuthErrorCode, localAuthMessage } from "../../lib/local-auth-api";
import { passkeysSupported } from "../../lib/passkey-browser";

type Method = NonNullable<NextStepResponse["methods"]>[number];

// The sign-in step after the password, for an account with a second factor:
// one of its passkeys, a code from the authenticator app, or a recovery code
// when both are lost. A recovery code does not sign in by itself; it leads to
// a new enrolment.
export function SecondFactorStep({ methods, onSignedIn, onRecovered, onPendingChange, actions = authFlowActions }: {
  onPendingChange?: (pending: boolean) => void;
  actions?: AuthFlowActions;
  methods: readonly Method[];
  onSignedIn: (session: AuthSessionResponse) => Promise<void> | void;
  onRecovered: () => void;
}) {
  const codeId = useId();
  const errorId = useId();
  const hasTotp = methods.includes("totp");
  const hasPasskey = methods.includes("passkey") && passkeysSupported();
  const [mode, setMode] = useState<"totp" | "recovery">(hasTotp ? "totp" : "recovery");
  const [showCode, setShowCode] = useState(!hasPasskey);
  const [code, setCode] = useState("");
  const { pending, busy, run, isBusy } = usePendingAction<"code" | "passkey">();
  const [invalidCode, setInvalidCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { onPendingChange?.(busy); }, [onPendingChange, busy]);

  const attempt = (key: "code" | "passkey", work: () => Promise<void>, fallback: string) => run(key, async () => {
    onPendingChange?.(true);
    setError(null);
    setInvalidCode(false);
    try {
      await work();
    } catch (caught) {
      const rejectedCode = localAuthErrorCode(caught) === "invalid_code";
      setInvalidCode(rejectedCode && key === "code");
      setError(rejectedCode && mode === "recovery"
        ? "That recovery code is not correct, or it was already used. Try an unused code from your saved recovery codes."
        : localAuthMessage(caught, fallback));
    }
  });

  const confirmWithPasskey = () =>
    attempt("passkey", async () => onSignedIn(await actions.submitPasskeySecondFactor()), "The passkey could not be checked. Try again.");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void attempt("code", async () => {
      if (mode === "totp") {
        await onSignedIn(await actions.submitTotpCode(code.trim()));
      } else {
        await actions.submitRecoveryCode(code.trim());
        onRecovered();
      }
    }, "The code could not be checked. Try again.");
  };

  // A method change only changes this page. It waits while a check runs.
  const switchTo = (next: "totp" | "recovery" | "passkey") => {
    if (isBusy()) return;
    setError(null);
    setInvalidCode(false);
    if (next === "passkey") {
      setShowCode(false);
      return;
    }
    setMode(next);
    setShowCode(true);
    setCode("");
  };

  const alternatives = [
    hasPasskey && showCode ? <Button key="passkey" type="button" variant="outline" disabled={busy} onClick={() => switchTo("passkey")}>Use a passkey</Button> : null,
    hasTotp && (!showCode || mode !== "totp") ? <Button key="totp" type="button" variant="outline" disabled={busy} onClick={() => switchTo("totp")}>Use my authenticator app</Button> : null,
    !showCode || mode !== "recovery" ? <Button key="recovery" type="button" variant="outline" disabled={busy} onClick={() => switchTo("recovery")}>Use a recovery code</Button> : null
  ].filter(Boolean);

  return (
    <div className="flex flex-col gap-4" aria-label="Two-step verification" role="group">
      <AuthStepHeading>{!showCode && hasPasskey ? "Verify with your passkey" : mode === "totp" ? "Enter your verification code" : "Use a recovery code"}</AuthStepHeading>
      {hasPasskey && !showCode ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-on-surface-variant">Confirm it is you with one of your passkeys.</p>
          <PendingButton type="button" pending={pending === "passkey"} pendingLabel="Waiting for the passkey…" aria-describedby={error ? errorId : undefined} onClick={() => void confirmWithPasskey()}>
            Use a passkey
          </PendingButton>
          {error ? <AuthMessage tone="error" id={errorId}>{error}</AuthMessage> : null}
          {pending === "passkey" ? <AuthMessage tone="note">Follow the passkey prompt from your browser.</AuthMessage> : null}
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-3">
          <p className="text-sm text-on-surface-variant">
            {mode === "totp"
              ? "Enter the 6-digit code from your authenticator app."
              : "Enter one of your recovery codes. You then set up a new second step."}
          </p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={codeId}>{mode === "totp" ? "Code" : "Recovery code"}</Label>
            <Input
              id={codeId}
              inputMode={mode === "totp" ? "numeric" : "text"}
              autoComplete="one-time-code"
              required
              {...pendingFieldProps(pending === "code")}
              aria-invalid={invalidCode ? true : undefined}
              aria-describedby={invalidCode ? errorId : undefined}
              value={code}
              onChange={(e) => { if (!isBusy()) setCode(e.target.value); }}
            />
            {error && invalidCode ? <AuthMessage tone="error" id={errorId}>{error}</AuthMessage> : null}
          </div>
          <PendingButton type="submit" pending={pending === "code"} pendingLabel="Checking…" aria-describedby={error && !invalidCode ? errorId : undefined}>Continue</PendingButton>
          {error && !invalidCode ? <AuthMessage id={errorId} tone="error">{error}</AuthMessage> : null}
          {pending === "code" ? <AuthMessage tone="note">Verification is in progress. Please wait…</AuthMessage> : null}
        </form>
      )}
      {alternatives.length > 0 ? <AuthAlternatives label="Other ways to verify">{alternatives}</AuthAlternatives> : null}
    </div>
  );
}
