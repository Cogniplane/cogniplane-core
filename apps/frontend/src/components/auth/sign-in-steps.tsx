"use client";

import { useCallback, useId, useRef, useState } from "react";
import type { EnrollmentCompleteResponse, NextStepResponse, TotpEnrollmentResponse } from "@cogniplane/shared-types";

import { AuthStepHeading } from "./auth-frame";
import { authFlowActions, type AuthFlowActions } from "./auth-flow-actions";
import { AuthAlternatives, AuthMessage, AuthTextButton, PendingButton, usePendingAction } from "./auth-ui";
import { Button } from "@/components/ui/button";
import { localAuthMessage } from "../../lib/local-auth-api";
import { passkeysSupported } from "../../lib/passkey-browser";
import { RecoveryCodesPanel } from "./recovery-codes-panel";
import { SecondFactorStep } from "./second-factor-step";
import { TotpEnrollment } from "./totp-enrollment";

// The local sign-in steps after the password (or a setup link): a second
// factor, or the enrolment that the policy, a manager reset, or a recovery
// code asks for. `onSession` receives the access token when the session
// exists; the backend has already set the refresh cookie. `onRestart` goes
// back to the password: the steps expire after five minutes. `passkeys`: the
// installation offers passkeys (GET /auth/config).
export function SignInSteps({ first, onSession, onRestart, passkeys = false, actions = authFlowActions }: {
  actions?: AuthFlowActions;
  first: NextStepResponse;
  onSession: (accessToken: string) => Promise<void> | void;
  onRestart: () => void;
  passkeys?: boolean;
}) {
  const passkeyErrorId = useId();
  const restartHintId = useId();
  const [step, setStep] = useState<"mfa" | "enroll" | "codes">(first.next);
  const [enrolled, setEnrolled] = useState<EnrollmentCompleteResponse | null>(null);
  const canUsePasskey = passkeys && passkeysSupported();
  const [enrolWith, setEnrolWith] = useState<"choose" | "totp">(canUsePasskey ? "choose" : "totp");
  const [childPending, setChildPending] = useState(false);
  const [startFailed, setStartFailed] = useState(false);
  const { busy: pending, run } = usePendingAction<"passkey">();
  const [error, setError] = useState<string | null>(null);
  // The sign-in flow keeps one authenticator setup. A person who switches to
  // the passkey and back sees the same QR code; the app start is not repeated.
  const totpStart = useRef<Promise<TotpEnrollmentResponse> | null>(null);
  const startTotp = useCallback(() => (totpStart.current ??= actions.startSignInEnrollment()), [actions]);

  if (step === "codes" && enrolled) {
    // The session exists now; there is nothing to restart.
    return <RecoveryCodesPanel copyCodes={actions.copyRecoveryCodes} downloadCodes={actions.downloadRecoveryCodes} codes={enrolled.recoveryCodes} onDone={() => onSession(enrolled.accessToken)} />;
  }

  const finishEnrolment = (result: EnrollmentCompleteResponse) => {
    setEnrolled(result);
    setStep("codes");
  };

  const enrolPasskey = () => run("passkey", async () => {
    setError(null);
    try {
      finishEnrolment(await actions.enrollPasskeyInSignIn());
    } catch (caught) {
      setError(localAuthMessage(caught, "The passkey could not be added. Try again."));
    }
  });

  const busy = pending || childPending;
  const totpView = step === "enroll" && enrolWith === "totp";
  // A failed app start leaves Start again as the only way on, so it becomes
  // the primary action right under the reason.
  const restartIsPrimary = totpView && startFailed;

  return (
    <div className="flex flex-col gap-4">
      {step === "mfa" ? (
        <SecondFactorStep
          actions={actions}
          onPendingChange={setChildPending}
          methods={first.methods ?? ["totp", "recovery_code"]}
          onSignedIn={(session) => onSession(session.accessToken)}
          onRecovered={() => setStep("enroll")}
        />
      ) : enrolWith === "choose" ? (
        <div className="flex flex-col gap-4">
          <AuthStepHeading>Set up two-step verification</AuthStepHeading>
          <p className="text-sm text-on-surface-variant">
            Your organization asks for a second step at sign-in. A passkey uses this device&apos;s screen lock, a
            security key, or your password manager.
          </p>
          <div className="flex flex-col gap-2">
            <PendingButton type="button" pending={pending} pendingLabel="Waiting for the passkey…" aria-describedby={error ? passkeyErrorId : undefined} onClick={() => void enrolPasskey()}>
              Add a passkey
            </PendingButton>
            {error ? <AuthMessage tone="error" id={passkeyErrorId}>{error}</AuthMessage> : null}
            {pending ? <AuthMessage tone="note">Follow the passkey prompt from your browser.</AuthMessage> : null}
          </div>
          <AuthAlternatives label="Other way to set up">
            <Button type="button" variant="outline" disabled={pending} onClick={() => { setError(null); setEnrolWith("totp"); }}>
              Use an authenticator app instead
            </Button>
          </AuthAlternatives>
        </div>
      ) : (
        <>
          <TotpEnrollment
            onPendingChange={setChildPending}
            onStartFailed={setStartFailed}
            restartHint="Start again to sign in and begin a new setup."
            start={startTotp}
            confirm={actions.confirmSignInEnrollment}
            intro="Your organization asks for a second step at sign-in. Scan this QR code with an authenticator app, such as Google Authenticator, Microsoft Authenticator, or 1Password."
            onConfirmed={finishEnrolment}
          />
          {canUsePasskey ? (
            <AuthAlternatives label="Other way to set up">
              <Button type="button" variant="outline" disabled={childPending} onClick={() => setEnrolWith("choose")}>Use a passkey instead</Button>
            </AuthAlternatives>
          ) : null}
        </>
      )}
      {restartIsPrimary ? (
        <Button type="button" onClick={onRestart}>Start again</Button>
      ) : (
        <div className="mt-1 flex flex-col items-start gap-1 border-t border-outline-variant pt-4">
          <AuthTextButton disabled={busy} aria-describedby={restartHintId} onClick={onRestart}>Start again</AuthTextButton>
          <p id={restartHintId} className="text-xs text-on-surface-variant">Ends this sign-in and returns to the password step.</p>
        </div>
      )}
    </div>
  );
}
