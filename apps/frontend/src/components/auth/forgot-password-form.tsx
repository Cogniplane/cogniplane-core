"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";

import { AuthFrame } from "./auth-frame";
import { AuthLink, AuthMessage, PendingButton, focusIfOwned, pendingFieldProps, usePendingAction } from "./auth-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fetchAuthConfig, localAuthMessage } from "../../lib/local-auth-api";
import { authFlowActions, type AuthFlowActions } from "./auth-flow-actions";
import { queryKeys } from "../../lib/query-keys";

// "Forgot password" (docs/architecture/local-accounts.md). The backend
// answers the same for every address, so this page shows the same message
// after every request: it never says whether an account exists.

export function ForgotPasswordForm() {
  const configQuery = useQuery({ queryKey: queryKeys.auth.config(), queryFn: fetchAuthConfig, retry: 1 });
  return <ForgotPasswordContent configQuery={configQuery} />;
}

export function ForgotPasswordContent({ configQuery, actions = authFlowActions }: {
  configQuery: { data?: { passwordRecovery: boolean }; isPending: boolean; isError: boolean; refetch: () => unknown };
  actions?: AuthFlowActions;
}) {
  const emailId = useId();
  const errorId = useId();
  const [email, setEmail] = useState("");
  const { pending, busy, run } = usePendingAction<"send" | "config">();
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const previousResult = useRef(sentTo);
  useEffect(() => {
    if (previousResult.current !== null && sentTo === null) focusIfOwned(emailInput.current);
    previousResult.current = sentTo;
  }, [sentTo]);

  // Try again keeps focus while the options load again. When they load, the
  // button leaves, so the title takes focus.
  const awaitingRetry = useRef(false);
  const recovery = configQuery.data?.passwordRecovery;
  useEffect(() => {
    if (awaitingRetry.current && recovery !== undefined) {
      awaitingRetry.current = false;
      focusIfOwned(heading.current);
    }
  }, [recovery]);
  const retryConfig = () => run("config", async () => {
    awaitingRetry.current = true;
    // A failed retry shows through isError; the button keeps focus.
    try { await configQuery.refetch(); } catch { /* the error state stays visible */ }
  });
  const showConfigError = configQuery.isError || (pending === "config" && recovery === undefined);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run("send", async () => {
      setError(null);
      try {
        await actions.requestPasswordReset(email.trim());
        setSentTo(email.trim());
      } catch (caught) {
        setError(localAuthMessage(caught, "The request could not be sent. Try again."));
      }
    });
  };

  return (
    <AuthFrame title={sentTo !== null ? "Check your email" : "Reset your password"} focusKey={sentTo !== null ? "result" : undefined} headingRef={heading}>

        {configQuery.isPending && !showConfigError ? <AuthMessage tone="progress" className="mt-4">Loading…</AuthMessage> : null}

        {showConfigError ? (
          <div className="mt-4 flex flex-col gap-3">
            <AuthMessage tone="error">The password recovery options could not load.</AuthMessage>
            <PendingButton variant="outline" pending={pending === "config"} pendingLabel="Trying again…" onClick={() => void retryConfig()}>Try again</PendingButton>
          </div>
        ) : null}

        {recovery === false ? (
          <p className="mt-4 text-sm text-on-surface-variant">
            This organization does not send reset links by email. Ask your administrator for a reset link.
          </p>
        ) : null}

        {recovery && sentTo !== null ? (
          <div className="mt-4 flex flex-col gap-3">
            <div role="status" className="flex flex-col gap-3">
            <p className="text-sm text-on-surface">
              If an account uses <span className="font-medium [overflow-wrap:anywhere]">{sentTo}</span>, we sent it a link to choose a new password.
              The link works for 30 minutes.
            </p>
            <p className="text-sm text-on-surface-variant">
              No email after a few minutes? Check your spam folder and the address, or ask your administrator.
            </p>
            </div>
            <Button variant="outline" onClick={() => { setSentTo(null); setEmail(""); }}>Use another address</Button>
          </div>
        ) : null}

        {recovery && sentTo === null ? (
          <form onSubmit={submit} className="mt-4 flex flex-col gap-4">
            <p className="text-sm text-on-surface-variant">
              Type the email address of your account. We send it a link to choose a new password.
            </p>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={emailId}>Email</Label>
              <Input ref={emailInput} id={emailId} type="email" autoComplete="username" required {...pendingFieldProps(pending === "send")} maxLength={320} value={email} onChange={(e) => { if (!busy) setEmail(e.target.value); }} />
            </div>
            <PendingButton type="submit" pending={pending === "send"} pendingLabel="Sending…" aria-describedby={error ? errorId : undefined}>Send the link</PendingButton>
            {error ? <AuthMessage id={errorId} tone="error">{error}</AuthMessage> : null}
          </form>
        ) : null}

        <AuthLink href="/login" className="mt-6">Back to sign-in</AuthLink>
    </AuthFrame>
  );
}
