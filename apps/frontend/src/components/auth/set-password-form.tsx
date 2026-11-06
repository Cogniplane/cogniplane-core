"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { type NextStepResponse, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@cogniplane/shared-types";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useAuth } from "../../lib/auth-context";
import { isNextStep, localAuthErrorCode, localAuthMessage } from "../../lib/local-auth-api";
import { authFlowActions, type AuthFlowActions } from "./auth-flow-actions";
import { AuthFrame } from "./auth-frame";
import { WorkspaceLoadFailure } from "./workspace-load-failure";
import { AuthLink, AuthMessage, NewPasswordInput, PendingButton, focusIfOwned, pendingFieldProps, usePendingAction } from "./auth-ui";
import { SignInSteps } from "./sign-in-steps";
import { passwordFieldError } from "./password-field-error";

// The page behind a one-time link (docs/ARCHITECTURE.md, "Authentication"). The
// token is in the URL fragment, so it reaches neither server logs nor the
// Referer header; the page removes it from the address bar at once, so it does
// not stay in the browser history either.

export type SetPasswordPurpose = "account_setup" | "password_reset";

const TEXT: Record<SetPasswordPurpose, { title: string; intro: string; submit: string }> = {
  account_setup: {
    title: "Set your password",
    intro: "Choose the password for your new account. You sign in with your email address and this password.",
    submit: "Set password and sign in"
  },
  password_reset: {
    title: "Choose a new password",
    intro: "Choose a new password for your account. When you save it, you are signed out on all devices; then sign in with the new password.",
    submit: "Change password"
  }
};

/** The token from `#token=…`, or null. */
export function readLinkToken(hash: string): string | null {
  const value = new URLSearchParams(hash.replace(/^#/, "")).get("token");
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

export function SetPasswordForm({ purpose }: { purpose: SetPasswordPurpose }) {
  const router = useRouter();
  const { completeLogin } = useAuth();
  const [token, setToken] = useState<string | null | undefined>(undefined);
  // The effect clears the fragment, so it must read it only once. React
  // Strict Mode runs an effect twice in development; the second run must not
  // replace the token with the empty fragment. The ref keeps the first read
  // in memory only, for the life of this page.
  const captured = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (captured.current === undefined) {
      captured.current = readLinkToken(window.location.hash);
      if (window.location.hash) {
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      }
    }
    setToken(captured.current);
  }, []);

  return <SetPasswordContent purpose={purpose} token={token} completeLogin={completeLogin} navigate={(path) => router.replace(path)} />;
}

export function SetPasswordContent({ purpose, token, completeLogin, navigate, actions = authFlowActions }: {
  purpose: SetPasswordPurpose;
  token: string | null | undefined;
  completeLogin: (accessToken: string) => Promise<boolean>;
  navigate: (path: string) => void;
  actions?: AuthFlowActions;
}) {
  const passwordId = useId();
  const confirmId = useId();
  const hintId = useId();
  const passwordErrorId = useId();
  const confirmErrorId = useId();
  const requestErrorId = useId();
  const passwordInput = useRef<HTMLInputElement>(null);
  const confirmInput = useRef<HTMLInputElement>(null);
  // A field error belongs under its field; a request error belongs by the submit button.
  const [fieldError, setFieldError] = useState<{ field: "password" | "confirm"; message: string } | null>(null);
  const [terminalLink, setTerminalLink] = useState(false);
  const [workspaceFailed, setWorkspaceFailed] = useState(false);
  const [passwordSaved, setPasswordSaved] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const { busy: pending, run } = usePendingAction<"save">();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [nextStep, setNextStep] = useState<NextStepResponse | null>(null);
  // Whether the enrolment step may offer a passkey; null until known. The
  // step mounts only after this is known, because it picks its first view
  // once.
  const [passkeys, setPasskeys] = useState<boolean | null>(null);
  useEffect(() => {
    if (nextStep?.next !== "enroll" || passkeys !== null) return;
    let cancelled = false;
    actions.fetchAuthConfig().then(
      (config) => { if (!cancelled) setPasskeys(config.passkeys); },
      () => { if (!cancelled) setPasskeys(false); }
    );
    return () => { cancelled = true; };
  }, [nextStep, passkeys, actions]);
  const stepsReady = nextStep !== null && (nextStep.next !== "enroll" || passkeys !== null);

  const startWorkspace = async (accessToken: string) => {
    try {
      if (await completeLogin(accessToken)) {
        navigate("/");
        return;
      }
    } catch {
      // The password/link is already consumed. Start a new sign-in.
    }
    setWorkspaceFailed(true);
  };

  const length = [...password.normalize("NFKC")].length;

  // Client checks move focus to the field to fix, like native form checks do.
  const refuse = (field: "password" | "confirm", message: string) => {
    setFieldError({ field, message });
    focusIfOwned(field === "password" ? passwordInput.current : confirmInput.current);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!token || pending || terminalLink || passwordSaved) return;
    setError(null);
    setFieldError(null);
    if (length < PASSWORD_MIN_LENGTH) return refuse("password", `Use at least ${PASSWORD_MIN_LENGTH} characters.`);
    if (password !== confirm) return refuse("confirm", "The two passwords are not the same.");
    const trigger = document.activeElement;
    void run("save", async () => {
      try {
        if (purpose === "account_setup") {
          const result = await actions.completeAccountSetup(token, password);
          setPasswordSaved(true);
          setPassword("");
          setConfirm("");
          if (isNextStep(result)) {
            setNextStep(result);
            return;
          }
          await startWorkspace(result.accessToken);
        } else {
          await actions.completePasswordReset(token, password);
          setPassword("");
          setConfirm("");
          setDone(true);
        }
      } catch (caught) {
        const code = localAuthErrorCode(caught);
        if (code === "link_invalid") {
          setTerminalLink(true);
          setPassword("");
          setConfirm("");
          return;
        }
        const fieldFailure = passwordFieldError(caught);
        if (fieldFailure?.field === "password") {
          // A server password rule: the message goes under New password. Focus
          // stays on the trigger; the field scrolls into view only while it does.
          setFieldError({ field: "password", message: fieldFailure.message });
          requestAnimationFrame(() => {
            if (document.activeElement === trigger) passwordInput.current?.scrollIntoView({ block: "nearest" });
          });
          return;
        }
        setError(localAuthMessage(caught, "Your password could not be saved. Try again."));
      }
    });
  };

  const text = TEXT[purpose];
  const linkEnded = token === null || terminalLink;
  const passwordError = fieldError?.field === "password" ? fieldError.message : null;
  const confirmError = fieldError?.field === "confirm" ? fieldError.message : null;
  if (workspaceFailed) return <WorkspaceLoadFailure />;
  return (
    <AuthFrame
      title={linkEnded ? terminalLink ? "Link expired or already used" : "Link incomplete" : done ? "Password changed" : nextStep ? "Finish account setup" : text.title}
      focusKey={linkEnded ? "new-link" : done ? "complete" : undefined}
    >

        {token === undefined ? <AuthMessage tone="progress">Checking your link…</AuthMessage> : null}

        {linkEnded ? (
          <div className="mt-4 flex flex-col gap-4">
            <AuthMessage tone="error">{terminalLink ? "This link is not valid any more, or it was already used." : "This link is not complete. Open the full link that you received, or ask for a new one."}</AuthMessage>
            {purpose === "account_setup" ? (
              <>
                {/* No self-service: an administrator sends setup links. Sign-in is the only next step here. */}
                <p className="text-sm text-on-surface-variant">Ask your administrator for a new account setup link. If you already set a password, go to sign-in.</p>
                <Button asChild><Link href="/login">Go to sign-in</Link></Button>
              </>
            ) : (
              <>
                <Button asChild><Link href="/auth/forgot-password">Get a new reset link</Link></Button>
                <AuthLink href="/login">Go to sign-in</AuthLink>
              </>
            )}
          </div>
        ) : null}

        {done ? (
          <div className="mt-4 flex flex-col gap-4">
            <AuthMessage tone="success">Your password is changed. Sign in with your new password.</AuthMessage>
            <Button asChild><Link href="/login">Sign in</Link></Button>
          </div>
        ) : null}

        {nextStep && !workspaceFailed ? (
          <div className="mt-4 flex flex-col gap-3">
            {/* The password is set; a restart is a normal sign-in. */}
            {stepsReady ? (
              <SignInSteps actions={actions} first={nextStep} passkeys={passkeys ?? false} onSession={startWorkspace} onRestart={() => navigate("/login")} />
            ) : (
              <AuthMessage tone="progress">Preparing the next step…</AuthMessage>
            )}
            {error ? <AuthMessage tone="error">{error}</AuthMessage> : null}
          </div>
        ) : null}

        {passwordSaved && !nextStep && !workspaceFailed ? <AuthMessage tone="progress">Your password is set. Opening your workspace…</AuthMessage> : null}

        {token && !terminalLink && !workspaceFailed && !passwordSaved && !done && !nextStep ? (
          <form onSubmit={submit} className="mt-4 flex flex-col gap-4">
            <p className="text-sm text-on-surface-variant">{text.intro}</p>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={passwordId}>New password</Label>
              <NewPasswordInput
                ref={passwordInput}
                id={passwordId}
                revealLabel="Show new password"
                autoComplete="new-password"
                required
                {...pendingFieldProps(pending)}
                aria-invalid={passwordError ? true : undefined}
                maxLength={PASSWORD_MAX_LENGTH * 2}
                aria-describedby={passwordError ? `${hintId} ${passwordErrorId}` : hintId}
                value={password}
                onChange={(e) => { if (!pending) setPassword(e.target.value); }}
              />
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs text-on-surface-variant">
                <p id={hintId}>At least {PASSWORD_MIN_LENGTH} characters. A few unrelated words work well.</p>
                <p className="tabular-nums">Length: {length} {length === 1 ? "character" : "characters"}</p>
              </div>
              {passwordError ? <AuthMessage tone="error" id={passwordErrorId}>{passwordError}</AuthMessage> : null}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={confirmId}>Type the password again</Label>
              <NewPasswordInput
                ref={confirmInput}
                id={confirmId}
                revealLabel="Show the password typed again"
                autoComplete="new-password"
                required
                {...pendingFieldProps(pending)}
                aria-invalid={confirmError ? true : undefined}
                aria-describedby={confirmError ? confirmErrorId : undefined}
                value={confirm}
                onChange={(e) => { if (!pending) setConfirm(e.target.value); }}
              />
              {confirmError ? <AuthMessage tone="error" id={confirmErrorId}>{confirmError}</AuthMessage> : null}
            </div>
            <PendingButton type="submit" pending={pending} pendingLabel="Saving…" aria-describedby={error ? requestErrorId : undefined}>{text.submit}</PendingButton>
            {error ? <AuthMessage id={requestErrorId} tone="error">{error}</AuthMessage> : null}
          </form>
        ) : null}
    </AuthFrame>
  );
}
