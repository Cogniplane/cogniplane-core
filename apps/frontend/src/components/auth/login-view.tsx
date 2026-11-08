"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { NextStepResponse } from "@cogniplane/shared-types";

import { isNextStep, localAuthMessage } from "../../lib/local-auth-api";
import { passkeysSupported } from "../../lib/passkey-browser";
import { AuthFrame } from "./auth-frame";
import { WorkspaceLoadFailure } from "./workspace-load-failure";
import { authFlowActions, type AuthFlowActions, type HostedLogin } from "./auth-flow-actions";
import { SignInSteps } from "./sign-in-steps";
import { AuthDisclosure, AuthLink, AuthMessage, PendingButton, focusIfOwned, pendingFieldProps, usePendingAction } from "./auth-ui";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// One page for both login types (docs/architecture/auth.md). It
// shows the forms the installation enables, side by side. It never asks for the
// email first to choose a form, so it does not reveal which login type an email
// uses.

function LocalSignInForm({
  actions,
  onWorkspaceFailure,
  disabled,
  onPendingChange,
  onStageChange,
  onSignedIn,
  passkeys,
  passwordRecovery
}: {
  actions: AuthFlowActions;
  onWorkspaceFailure: () => void;
  disabled: boolean;
  onPendingChange: (pending: boolean) => void;
  onStageChange: (active: boolean) => void;
  onSignedIn: (accessToken: string) => Promise<boolean>;
  passkeys: boolean;
  passwordRecovery: boolean;
}) {
  const emailId = useId();
  const passwordId = useId();
  const passkeyErrorId = useId();
  const passwordErrorId = useId();
  const emailInput = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { pending, busy, run } = usePendingAction<"password" | "passkey">();
  // Each sign-in action owns its error, so the message sits by the control that failed.
  const [error, setError] = useState<{ source: "password" | "passkey"; message: string } | null>(null);
  const [nextStep, setNextStep] = useState<NextStepResponse | null>(null);
  const canUsePasskey = passkeys && passkeysSupported();
  useEffect(() => { onPendingChange(busy); }, [busy, onPendingChange]);

  // Start again returns here with the email kept and the password cleared.
  const restarted = useRef(false);
  useEffect(() => {
    if (nextStep === null && restarted.current) {
      restarted.current = false;
      focusIfOwned(emailInput.current);
    }
  }, [nextStep]);

  const finish = async (accessToken: string) => {
    if (!(await onSignedIn(accessToken))) {
      onStageChange(true);
      onWorkspaceFailure();
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (disabled) return;
    void run("password", async () => {
      onPendingChange(true);
      setError(null);
      try {
        const result = await actions.signInWithPassword(email, password);
        if (isNextStep(result)) {
          setPassword("");
          setNextStep(result);
          onStageChange(true);
        } else {
          await finish(result.accessToken);
        }
      } catch (caught) {
        setError({ source: "password", message: localAuthMessage(caught, "Sign-in is unavailable right now.") });
      }
    });
  };

  // Passwordless: the browser offers the passkeys it has for this site, so no
  // email is needed and the page reveals nothing about any account.
  const signInWithPasskeyNow = () => {
    if (disabled) return;
    void run("passkey", async () => {
      onPendingChange(true);
      setError(null);
      try {
        await finish((await actions.signInWithPasskey()).accessToken);
      } catch (caught) {
        setError({ source: "passkey", message: localAuthMessage(caught, "Sign-in with a passkey is unavailable right now.") });
      }
    });
  };

  if (nextStep) {
    return <SignInSteps actions={actions} first={nextStep} passkeys={passkeys} onSession={finish} onRestart={() => { restarted.current = true; setError(null); setNextStep(null); onStageChange(false); }} />;
  }

  const fieldsWait = pending === "password";
  const otherWaits = disabled || pending === "passkey";
  return (
    <form onSubmit={submit} className="flex flex-col gap-3" aria-label="Sign in with email and password">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={emailId}>Email</Label>
        <Input ref={emailInput} id={emailId} type="email" autoComplete="username" required disabled={otherWaits} {...pendingFieldProps(fieldsWait)} value={email} onChange={(e) => { if (!busy) setEmail(e.target.value); }} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={passwordId}>Password</Label>
        <Input id={passwordId} type="password" autoComplete="current-password" required disabled={otherWaits} {...pendingFieldProps(fieldsWait)} value={password} onChange={(e) => { if (!busy) setPassword(e.target.value); }} />
      </div>
      <PendingButton type="submit" pending={pending === "password"} pendingLabel="Signing in…" disabled={otherWaits} className="w-full" aria-describedby={error?.source === "password" ? passwordErrorId : undefined}>
        Sign in
      </PendingButton>
      {error?.source === "password" ? <AuthMessage id={passwordErrorId} tone="error">{error.message}</AuthMessage> : null}
      {canUsePasskey ? (
        <>
          <PendingButton
            type="button"
            variant="outline"
            className="w-full"
            pending={pending === "passkey"}
            pendingLabel="Waiting for the passkey…"
            disabled={disabled || pending === "password"}
            aria-describedby={error?.source === "passkey" ? passkeyErrorId : undefined}
            onClick={signInWithPasskeyNow}
          >
            Sign in with a passkey
          </PendingButton>
          {pending === "passkey" ? <AuthMessage tone="note">Follow the passkey prompt from your browser.</AuthMessage> : null}
          {error?.source === "passkey" ? <AuthMessage tone="error" id={passkeyErrorId}>{error.message}</AuthMessage> : null}
        </>
      ) : null}
      {passwordRecovery ? (
        <AuthLink href="/auth/forgot-password">Forgot your password?</AuthLink>
      ) : (
        <p className="text-xs text-on-surface-variant">Forgot your password? Ask your administrator for a reset link.</p>
      )}
    </form>
  );
}

type HostedAction = "company" | "organization";

function WorkosSignIn({ alongsideLocal, login, disabled, onPendingChange }: { alongsideLocal: boolean; login: HostedLogin; disabled: boolean; onPendingChange: (pending: boolean) => void }) {
  const orgId = useId();
  const orgHelpId = useId();
  const companyErrorId = useId();
  const organizationErrorId = useId();
  const [ssoOrg, setSsoOrg] = useState("");
  const work = usePendingAction<HostedAction>();
  // A successful hosted login leaves the page, so its action stays pending
  // until the browser navigates. A failure restores the actions.
  const [leaving, setLeaving] = useState<HostedAction | null>(null);
  const pending = work.pending ?? leaving;
  const busy = pending !== null;
  // Each hosted action owns its error, beside the button that failed.
  const [failed, setFailed] = useState<HostedAction | null>(null);
  useEffect(() => { onPendingChange(busy); }, [busy, onPendingChange]);

  const startLogin = (action: HostedAction, options?: { organization?: string }) => {
    if (disabled || leaving) return;
    void work.run(action, async () => {
      onPendingChange(true);
      setFailed(null);
      try {
        await login(options);
        setLeaving(action);
      } catch {
        setFailed(action);
      }
    });
  };

  return (
    <div className="flex flex-col gap-3">
      {alongsideLocal ? (
        <p className="text-sm text-on-surface-variant">Use the sign-in page provided by your organization.</p>
      ) : null}
      <form onSubmit={(e) => { e.preventDefault(); startLogin("company"); }} className="flex flex-col gap-3">
        <PendingButton
          type="submit"
          variant={alongsideLocal ? "outline" : "default"}
          pending={pending === "company"}
          pendingLabel="Redirecting…"
          disabled={disabled || pending === "organization"}
          aria-describedby={failed === "company" ? companyErrorId : undefined}
          className="h-auto min-h-9 w-full whitespace-normal"
        >
          Continue with your company account
        </PendingButton>
        {pending === "company" ? <AuthMessage tone="note">Opening your organization&apos;s sign-in page…</AuthMessage> : null}
        {failed === "company" ? <AuthMessage tone="error" id={companyErrorId}>Company sign-in is unavailable right now. Try again.</AuthMessage> : null}
      </form>

      <AuthDisclosure summary="Have an organization identifier?" className="mt-2 border-t border-outline-variant pt-5">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (ssoOrg.trim()) startLogin("organization", { organization: ssoOrg.trim() });
          }}
          className="mt-4 flex flex-col gap-3"
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={orgId}>Organization identifier</Label>
            <Input
              id={orgId}
              aria-describedby={orgHelpId}
              disabled={disabled || pending === "company"}
              {...pendingFieldProps(pending === "organization")}
              type="text"
              value={ssoOrg}
              onChange={(e) => { if (!busy) setSsoOrg(e.target.value); }}
            />
            <p id={orgHelpId} className="text-xs text-on-surface-variant">Optional. Use the identifier your administrator gave you to open your organization&apos;s sign-in page.</p>
          </div>
          <PendingButton
            type="submit"
            variant="outline"
            pending={pending === "organization"}
            pendingLabel="Redirecting…"
            disabled={disabled || pending === "company" || !ssoOrg.trim()}
            aria-describedby={failed === "organization" ? organizationErrorId : undefined}
            className="w-full"
          >
            Continue with organization
          </PendingButton>
          {pending === "organization" ? <AuthMessage tone="note">Opening your organization&apos;s sign-in page…</AuthMessage> : null}
          {failed === "organization" ? <AuthMessage tone="error" id={organizationErrorId}>Sign-in with this organization identifier is unavailable right now. Check the identifier, then try again.</AuthMessage> : null}
        </form>
      </AuthDisclosure>
    </div>
  );
}


export function LoginView({ config, configError, onConfigRetry, onSignedIn, login, onReload = () => window.location.reload(), actions = authFlowActions }: {
  config: Awaited<ReturnType<AuthFlowActions["fetchAuthConfig"]>> | null;
  configError: boolean;
  onConfigRetry: () => unknown;
  onSignedIn: (accessToken: string) => Promise<boolean>;
  login: HostedLogin;
  onReload?: () => void;
  actions?: AuthFlowActions;
}) {
  const [localPending, setLocalPending] = useState(false);
  const [hostedPending, setHostedPending] = useState(false);
  const [localStage, setLocalStage] = useState(false);
  const [workspaceFailed, setWorkspaceFailed] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const retry = usePendingAction<"config">();
  // Try again keeps focus while the options load again. When they load, the
  // button leaves, so the title takes focus.
  const awaitingRetry = useRef(false);
  useEffect(() => {
    if (awaitingRetry.current && config) {
      awaitingRetry.current = false;
      focusIfOwned(heading.current);
    }
  }, [config]);
  const local = config?.loginTypes.includes("local") ?? false;
  const workos = config?.loginTypes.includes("workos") ?? false;
  const showConfigError = configError || (retry.busy && !config);

  if (workspaceFailed) return <WorkspaceLoadFailure onReload={onReload} />;

  return (
    <AuthFrame title="Sign in to your workspace" headingRef={heading}>
        {showConfigError ? (
          <div className="flex flex-col gap-3">
            <AuthMessage tone="error">The sign-in options could not load.</AuthMessage>
            <PendingButton
              variant="outline"
              pending={retry.busy}
              pendingLabel="Trying again…"
              onClick={() => void retry.run("config", async () => {
                awaitingRetry.current = true;
                // A failed retry shows through configError; the button keeps focus.
                try { await onConfigRetry(); } catch { /* the error state stays visible */ }
              })}
            >
              Try again
            </PendingButton>
          </div>
        ) : null}

        {!config && !showConfigError ? <AuthMessage tone="progress">Loading sign-in…</AuthMessage> : null}

        {local ? (
          <LocalSignInForm onWorkspaceFailure={() => setWorkspaceFailed(true)} disabled={hostedPending} onPendingChange={setLocalPending} onStageChange={setLocalStage} actions={actions} onSignedIn={onSignedIn} passkeys={config?.passkeys ?? false} passwordRecovery={config?.passwordRecovery ?? false} />
        ) : null}

        {local && workos && !localStage ? (
          <div className="my-6 flex items-center gap-4 text-xs uppercase tracking-wide text-on-surface-faint">
            <span className="h-px flex-1 bg-outline-variant" />
            <span>or</span>
            <span className="h-px flex-1 bg-outline-variant" />
          </div>
        ) : null}

        {workos && !localStage ? <WorkosSignIn disabled={localPending} onPendingChange={setHostedPending} login={login} alongsideLocal={local} /> : null}
    </AuthFrame>
  );
}
