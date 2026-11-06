"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import type { StepUpAction } from "@cogniplane/shared-types";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fetchMySecurity, localAuthMessage, stepUp, type StepUpProof } from "../../../lib/local-auth-api";
import { passkeysSupported } from "../../../lib/passkey-browser";
import { queryKeys } from "../../../lib/query-keys";
import { AuthMessage, PendingButton, pendingFieldProps, usePendingAction } from "../../auth/auth-ui";

// Fresh proof for one sensitive action: the user's own password, or, when the
// account has a second factor, a code from the authenticator app or one of
// its passkeys (the backend then requires one: strong step-up). The backend
// returns a one-use token for this action, and `run` spends it at once.
export function StepUpDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  action: StepUpAction;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  run: (stepUpToken: string) => Promise<void>;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const passwordId = useId();
  const formId = useId();
  const errorId = useId();
  const security = useQuery({ queryKey: queryKeys.settings.security(), queryFn: fetchMySecurity, enabled: props.open });
  const securityReady = security.isSuccess && !security.isFetching;
  const useCode = securityReady && security.data.totpEnabled;
  const hasPasskey = securityReady && (security.data.passkeyCount ?? 0) > 0;
  const usePasskey = hasPasskey && passkeysSupported();
  const unsupportedPasskey = hasPasskey && !usePasskey && !useCode;
  const canConfirm = securityReady && !unsupportedPasskey;
  // With only passkeys, there is nothing to type.
  const passkeyOnly = usePasskey && !useCode;
  const [password, setPassword] = useState("");
  const { busy: pending, pending: pendingAction, isBusy, run } = usePendingAction<"confirm" | "passkey">();
  const retry = usePendingAction<"security">();
  const [error, setError] = useState<string | null>(null);
  // The method whose request failed. Only that control is described by the error.
  const [errorAction, setErrorAction] = useState<"confirm" | "passkey">("confirm");
  const errorOwner = useRef<Element | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [decisionBottom, setDecisionBottom] = useState<number | null>(null);

  useEffect(() => {
    const releasePosition = () => setDecisionBottom(null);
    window.addEventListener("resize", releasePosition);
    return () => window.removeEventListener("resize", releasePosition);
  }, []);

  useEffect(() => {
    if (error && errorOwner.current === document.activeElement) {
      document.getElementById(errorId)?.scrollIntoView?.({ block: "nearest" });
    }
  }, [error, errorId]);

  const close = (open: boolean) => {
    if (pending) return;
    if (!open) {
      setPassword("");
      setError(null);
      setDecisionBottom(null);
    }
    props.onOpenChange(open);
  };

  const anchorDecision = () => {
    const dialog = formRef.current?.closest<HTMLElement>('[data-slot="dialog-content"]');
    if (dialog && decisionBottom === null) {
      // Grow feedback upward from the current decision row, within the viewport.
      setDecisionBottom(Math.max(16, window.innerHeight - dialog.getBoundingClientRect().bottom));
    }
  };

  const retrySecurity = () => retry.run("security", async () => {
    if (security.isFetching || isBusy()) return;
    anchorDecision();
    setError(null);
    await security.refetch();
  });

  const confirm = (proof: StepUpProof, owner: "confirm" | "passkey" = "confirm") => {
    if (!props.open || !canConfirm) return;
    return run(owner, async () => {
      errorOwner.current = document.activeElement;
      anchorDecision();
      setError(null);
      try {
        const token = await stepUp(props.action, proof);
        await props.run(token);
        setPassword("");
        setDecisionBottom(null);
        props.onOpenChange(false);
      } catch (caught) {
        setErrorAction(owner);
        setError(localAuthMessage(caught, "The action failed. Try again."));
      }
    });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canConfirm) return;
    void confirm(passkeyOnly ? { passkey: true } : useCode ? { totpCode: password.trim() } : { password });
  };

  return (
    <Dialog open={props.open} onOpenChange={close}>
      <DialogContent className={decisionBottom === null ? "transition-none" : "top-auto translate-y-0 transition-none"} style={decisionBottom === null ? undefined : { bottom: decisionBottom, maxHeight: `calc(100dvh - ${decisionBottom}px - 1rem)` }} onOpenAutoFocus={() => setDecisionBottom(null)} onCloseAutoFocus={props.onCloseAutoFocus} footer={
        <DialogFooter className="static shrink-0 flex-col border-t border-outline-variant pt-3 shadow-none sm:flex-col">
          {error ? <AuthMessage id={errorId} tone="error">{error}</AuthMessage> : null}
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" disabled={pending} onClick={() => close(false)}>Cancel</Button>
            <PendingButton type="submit" form={formId} variant={props.destructive ? "destructive" : "default"} disabled={!canConfirm || (pending && pendingAction !== "confirm")} pending={pendingAction === "confirm"} reserveIconSpace aria-describedby={error && errorAction === "confirm" ? errorId : undefined}>
              <span>{props.confirmLabel}</span>
              <span aria-hidden="true" className="size-4 shrink-0" />
            </PendingButton>
          </div>
        </DialogFooter>
      }>
        <form ref={formRef} id={formId} onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{props.title}</DialogTitle>
            <DialogDescription>{props.description}</DialogDescription>
          </DialogHeader>
          {!securityReady ? (
            <div className="flex flex-col items-start gap-3">
              {security.isFetching || security.isPending ? (
                <AuthMessage tone="note">Checking how to confirm your identity...</AuthMessage>
              ) : (
                <AuthMessage tone="error">Could not load your security methods. Retry to confirm this action.</AuthMessage>
              )}
              {security.isError || retry.busy ? (
                <PendingButton type="button" variant="outline" pending={retry.busy} reserveIconSpace onClick={() => void retrySecurity()}>Retry security check</PendingButton>
              ) : null}
            </div>
          ) : unsupportedPasskey ? (
            <AuthMessage tone="error">This account requires a passkey. Open this page in a browser that supports passkeys, then try again.</AuthMessage>
          ) : passkeyOnly ? (
            <p className="text-sm text-on-surface-variant">To protect accounts, confirm this action with one of your passkeys.</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={passwordId}>{useCode ? "Code from your authenticator app" : "Your password"}</Label>
              <Input
                id={passwordId}
                type={useCode ? "text" : "password"}
                inputMode={useCode ? "numeric" : undefined}
                autoComplete={useCode ? "one-time-code" : "current-password"}
                required
                value={password}
                onChange={(e) => { if (!isBusy()) setPassword(e.target.value); }}
                {...pendingFieldProps(pending)}
              />
              <p className="text-xs text-on-surface-variant">
                {useCode
                  ? "To protect accounts, confirm this action with a code from your authenticator app."
                  : "To protect accounts, confirm your own password for this action."}
              </p>
            </div>
          )}
          {usePasskey && !passkeyOnly ? (
            <PendingButton type="button" variant="outline" className="self-start" disabled={pending && pendingAction !== "passkey"} pending={pendingAction === "passkey"} reserveIconSpace aria-describedby={error && errorAction === "passkey" ? errorId : undefined} onClick={() => void confirm({ passkey: true }, "passkey")}>
              <span>Use a passkey instead</span>
              <span aria-hidden="true" className="size-4 shrink-0" />
            </PendingButton>
          ) : null}
        </form>
      </DialogContent>
    </Dialog>
  );
}
