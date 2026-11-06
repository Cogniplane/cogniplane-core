"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { type MySecurityResponse, PASSWORD_MIN_LENGTH, type PasskeySummary } from "@cogniplane/shared-types";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "../lib/auth-context";
import { queryKeys } from "../lib/query-keys";
import {
  addMyPasskey,
  changeMyPassword,
  confirmMyTotp,
  fetchAuthConfig,
  fetchMySecurity,
  listMyPasskeys,
  localAuthMessage,
  regenerateMyRecoveryCodes,
  removeMyPasskey,
  removeMyTotp,
  renameMyPasskey,
  signOutEverywhere,
  startMyTotp
} from "../lib/local-auth-api";
import { passkeysSupported } from "../lib/passkey-browser";
import { StepUpDialog } from "./admin/people/step-up-dialog";
import { RecoveryCodesPanel } from "./auth/recovery-codes-panel";
import { TotpEnrollmentTask } from "./auth/totp-enrollment-task";
import { AuthTaskScope } from "./auth/auth-frame";
import { AUTH_FOCUS_RING, AuthMessage, PendingButton, focusIfOwned, pendingFieldProps, usePendingAction } from "./auth/auth-ui";
import { passwordFieldError } from "./auth/password-field-error";

// Settings › Sign-in & security, for members of a tenant with local login
// (docs/ARCHITECTURE.md, "Authentication").

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

type SecurityRead = UseQueryResult<MySecurityResponse>;

const SECURITY_SECTION_HEADING = "text-lg font-semibold text-on-surface";

function ReadNotice({ pending, failed, fetching, hasData, loading, unavailable, retained, retryLabel, retry, focusId }: {
  pending: boolean;
  failed: boolean;
  fetching: boolean;
  hasData: boolean;
  loading: string;
  unavailable: string;
  retained: string;
  retryLabel: string;
  retry: () => Promise<unknown>;
  focusId: string;
}) {
  if (!failed && !pending) return null;
  return (
    <div className="flex min-w-0 flex-col items-start gap-2 rounded-md bg-surface-container p-3">
      <p role={failed ? "alert" : "status"} className={`text-sm ${failed ? "text-danger" : "text-on-surface-variant"}`}>
        {failed ? (hasData ? retained : unavailable) : loading}
      </p>
      {failed ? (
        <Button type="button" variant="outline" size="sm" disabled={fetching} aria-busy={fetching}
          onClick={async (event) => {
            const button = event.currentTarget;
            await retry();
            if (document.activeElement === button || document.activeElement === document.body) {
              document.getElementById(focusId)?.focus();
            }
          }}>
          {fetching ? "Retrying…" : retryLabel}
        </Button>
      ) : null}
    </div>
  );
}

function PasswordChange({ security }: { security: SecurityRead }) {
  const { completeLogin } = useAuth();
  const currentId = useId();
  const nextId = useId();
  const confirmId = useId();
  const errorId = useId();
  const currentInput = useRef<HTMLInputElement>(null);
  const nextInput = useRef<HTMLInputElement>(null);
  const confirmInput = useRef<HTMLInputElement>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const { busy: pending, isBusy, run } = usePendingAction<"password">();
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<"current" | "next" | "confirm" | null>(null);
  const [status, setStatus] = useState("");
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const stepUpFieldRecovery = useRef<{ target: HTMLInputElement | null; owner: Element | null; owned: boolean } | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (isBusy()) return;
    setError(null);
    setFieldError(null);
    setStatus("");
    if (!security.data || security.isError || security.isFetching) return;
    if ([...next.normalize("NFKC")].length < PASSWORD_MIN_LENGTH) {
      setError(`Use at least ${PASSWORD_MIN_LENGTH} characters.`);
      setFieldError("next");
      nextInput.current?.focus();
      return;
    }
    if (next !== confirm) {
      setError("The two new passwords are not the same.");
      setFieldError("confirm");
      confirmInput.current?.focus();
      return;
    }
    // With a second factor, the change needs it first (strong step-up).
    if (security.data && (security.data.totpEnabled || security.data.passkeyCount > 0)) {
      setStepUpOpen(true);
      return;
    }
    await change();
  };

  const change = (stepUpToken?: string) => run("password", async () => {
    const trigger = document.activeElement;
    setError(null);
    setFieldError(null);
    setStatus("");
    try {
      const session = await changeMyPassword(current, next, stepUpToken);
      // The change ended every session; this browser gets the new one.
      await completeLogin(session.accessToken);
      setCurrent("");
      setNext("");
      setConfirm("");
      void security.refetch();
      setStatus("Your password is changed. You are signed out on every other device.");
    } catch (caught) {
      const fieldFailure = passwordFieldError(caught, true);
      setFieldError(fieldFailure ? (fieldFailure.field === "current" ? "current" : "next") : null);
      setError(fieldFailure?.message ?? localAuthMessage(caught, "Your password could not be changed. Try again."));
      if (fieldFailure && stepUpToken) {
        const owner = document.activeElement;
        stepUpFieldRecovery.current = {
          target: fieldFailure.field === "current" ? currentInput.current : nextInput.current,
          owner,
          owned: !!owner?.closest('[role="dialog"]')
        };
        // The form owns this error. Let confirmation close so the field and
        // its message are visible, without reporting a successful change.
        return;
      }
      if (fieldFailure) {
        requestAnimationFrame(() => {
          if (trigger && currentInput.current?.form?.contains(trigger) && document.activeElement === trigger) {
            const input = fieldFailure.field === "current" ? currentInput.current : nextInput.current;
            input?.scrollIntoView?.({ block: "nearest" });
          }
        });
      }
      if (stepUpToken) throw caught;
    }
  });

  return (
    <section aria-labelledby={`${currentId}-heading`} className="flex flex-col gap-4">
      <div>
        <h3 id={`${currentId}-heading`} tabIndex={-1} className={SECURITY_SECTION_HEADING}>Password</h3>
        {security.data?.passwordChangedAt ? (
          <p className="text-sm text-on-surface-variant">Last changed {formatDate(security.data.passwordChangedAt)}.</p>
        ) : null}
      </div>
      <ReadNotice pending={security.isPending} failed={security.isError} fetching={security.isFetching} hasData={!!security.data}
        loading="Loading security details…" unavailable="Security details could not be loaded. Load them before changing your password or second steps."
        retained="Security details could not be refreshed. Showing the last loaded security details. Retry before changing your password or second steps."
        retryLabel="Retry security details" retry={() => security.refetch()} focusId={`${currentId}-heading`} />
      <form onSubmit={submit} className="flex max-w-sm flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={currentId}>Current password</Label>
          <Input ref={currentInput} id={currentId} type="password" autoComplete="current-password" required {...pendingFieldProps(pending)} aria-invalid={fieldError === "current" || undefined} aria-describedby={fieldError === "current" ? errorId : undefined} value={current} onChange={(e) => { if (!isBusy()) setCurrent(e.target.value); }} />
          {error && fieldError === "current" ? <AuthMessage id={errorId} tone="error">{error}</AuthMessage> : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={nextId}>New password</Label>
          <Input ref={nextInput} id={nextId} type="password" autoComplete="new-password" required {...pendingFieldProps(pending)} aria-invalid={fieldError === "next" || undefined} aria-describedby={fieldError === "next" ? errorId : undefined} value={next} onChange={(e) => { if (!isBusy()) setNext(e.target.value); }} />
          <p className="text-xs text-on-surface-variant">At least {PASSWORD_MIN_LENGTH} characters.</p>
          {error && fieldError === "next" ? <AuthMessage id={errorId} tone="error">{error}</AuthMessage> : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={confirmId}>Type the new password again</Label>
          <Input ref={confirmInput} id={confirmId} type="password" autoComplete="new-password" required {...pendingFieldProps(pending)} aria-invalid={fieldError === "confirm" || undefined} aria-describedby={fieldError === "confirm" ? errorId : undefined} value={confirm} onChange={(e) => { if (!isBusy()) setConfirm(e.target.value); }} />
          {error && fieldError === "confirm" ? <AuthMessage id={errorId} tone="error">{error}</AuthMessage> : null}
        </div>
        <p className="text-xs text-on-surface-variant">A new password signs you out on every other device. Running agent work stops.</p>
        <PendingButton type="submit" className="self-start" disabled={!security.data || security.isError || security.isFetching} pending={pending} pendingLabel="Saving…" aria-describedby={error && !fieldError ? errorId : undefined}>Change password</PendingButton>
        {error && !fieldError ? <AuthMessage id={errorId} tone="error">{error}</AuthMessage> : null}
      </form>
      <div role="status" aria-live="polite" aria-atomic="true" className={status ? undefined : "sr-only"}>
        {status ? <AuthMessage tone="success" announce={false}>{status}</AuthMessage> : null}
      </div>
      <StepUpDialog
        open={stepUpOpen}
        onOpenChange={setStepUpOpen}
        action="self.password_change"
        title="Confirm the password change"
        description="Your account has two-step verification. Confirm the change with your second step. Running agent work stops."
        confirmLabel="Change password"
        run={(token) => change(token)}
        onCloseAutoFocus={(event) => {
          const recovery = stepUpFieldRecovery.current;
          stepUpFieldRecovery.current = null;
          if (!recovery) return;
          event.preventDefault();
          if (recovery.owned && (document.activeElement === recovery.owner || document.activeElement === document.body)) {
            recovery.target?.focus();
          }
        }}
      />
    </section>
  );
}

/**
 * The two-step verification section: its h3, status line and content. An
 * enrollment or code task renders inside it with h4 task headings. When a
 * task ends (saved codes or Cancel), its control leaves, so the section
 * heading takes focus unless the person moved focus elsewhere.
 */
export type TwoStepStatus = { message: string; tone: "success" | "note" };

export function TwoStepSection({ status, taskActive, children }: { status: TwoStepStatus | null; taskActive: boolean; children: ReactNode }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const hadTask = useRef(taskActive);
  useEffect(() => {
    if (hadTask.current && !taskActive) focusIfOwned(heading.current);
    hadTask.current = taskActive;
  }, [taskActive]);
  return (
    <section aria-labelledby="two-step-heading" className="flex flex-col gap-3 border-t border-outline-variant pt-6">
      <h3 ref={heading} id="two-step-heading" tabIndex={-1} className={`w-fit rounded-sm ${SECURITY_SECTION_HEADING} ${AUTH_FOCUS_RING}`}>Two-step verification</h3>
      <div role="status" aria-live="polite" aria-atomic="true" className={status ? undefined : "sr-only"}>
        {status ? <AuthMessage tone={status.tone} announce={false}>{status.message}</AuthMessage> : null}
      </div>
      {children}
    </section>
  );
}

/** A settings task (enrollment or codes): h4 task headings at a readable form width. */
export function TwoStepTask({ children }: { children: ReactNode }) {
  return <AuthTaskScope level={4} className="max-w-md">{children}</AuthTaskScope>;
}

type TwoStepMode =
  | { kind: "view" }
  | { kind: "enroll"; stepUpToken: string }
  | { kind: "codes"; codes: string[]; done: string };

function TwoStepVerification({ security }: { security: SecurityRead }) {
  const { adoptSession, completeLogin } = useAuth();
  const config = useQuery({ queryKey: queryKeys.auth.config(), queryFn: fetchAuthConfig });
  const [mode, setMode] = useState<TwoStepMode>({ kind: "view" });
  const [dialog, setDialog] = useState<"totp_start" | "totp_remove" | "codes" | null>(null);
  const [status, setStatus] = useState<TwoStepStatus | null>(null);
  const data = security.data;
  const enrollToken = mode.kind === "enroll" ? mode.stepUpToken : "";
  // Cancel can leave a start running. The server keeps the last pending secret
  // it writes, so a new start waits until the earlier one answers; then the QR
  // code on screen is the one that the server keeps.
  const lastStart = useRef<Promise<unknown>>(Promise.resolve());
  const start = useCallback(() => {
    const next = lastStart.current.catch(() => undefined).then(() => startMyTotp(enrollToken));
    lastStart.current = next;
    return next;
  }, [enrollToken]);

  if (!data) return (
    <section aria-labelledby="two-step-heading" className="flex flex-col gap-3 border-t border-outline-variant pt-6">
      <h3 id="two-step-heading" className={SECURITY_SECTION_HEADING}>Two-step verification</h3>
      <p className="text-sm text-on-surface-variant">Load security details to see your second steps.</p>
    </section>
  );
  const securityReady = !security.isError && !security.isFetching;
  const hasFactor = data.totpEnabled || data.passkeyCount > 0;
  // The last factor cannot go when the organization requires one.
  const totpIsLastRequired = data.mfaRequired && data.passkeyCount === 0;
  const showCodes = (codes: string[], done: string) => setMode({ kind: "codes", codes, done });

  return (
    <TwoStepSection status={status} taskActive={mode.kind !== "view"}>
      {mode.kind === "enroll" ? (
        <TwoStepTask>
          <TotpEnrollmentTask
            start={start}
            onCancel={() => { setMode({ kind: "view" }); setStatus({ message: "Authenticator setup cancelled. Your settings have not changed.", tone: "note" }); }}
            confirm={confirmMyTotp}
            onConfirmed={(result) => {
              // Every older session ended. This browser takes the new one now,
              // not when the codes are saved: the token can expire while the
              // person reads the codes, and a refresh in that time gives a newer
              // token. Only the token changes, so the codes stay on the page.
              adoptSession(result.accessToken, result.user);
              showCodes(result.recoveryCodes, "Your authenticator app is set up.");
            }}
          />
        </TwoStepTask>
      ) : null}
      {mode.kind === "codes" ? (
        <TwoStepTask>
          <RecoveryCodesPanel
            codes={mode.codes}
            onDone={() => {
              setMode({ kind: "view" });
              setStatus({ message: mode.done, tone: "success" });
              void security.refetch();
            }}
          />
        </TwoStepTask>
      ) : null}

      {mode.kind === "view" ? (
        <div className="flex flex-col gap-5">
          <p className="text-sm text-on-surface-variant">
            {hasFactor
              ? `On. You sign in with your password and a second step. ${data.recoveryCodesRemaining} recovery ${data.recoveryCodesRemaining === 1 ? "code" : "codes"} left.`
              : "Off. Add an authenticator app or a passkey, so that a stolen password alone cannot open your account."}
          </p>
          {hasFactor ? (
            <Button variant="outline" className="self-start" disabled={!securityReady} onClick={() => setDialog("codes")}>Make new recovery codes…</Button>
          ) : null}

          <div className="flex flex-col gap-2">
            <h4 className="text-base font-semibold text-on-surface">Authenticator app</h4>
            {data.totpEnabled ? (
              <>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" disabled={!securityReady} onClick={() => setDialog("totp_start")}>Use a new phone…</Button>
                  <Button variant="ghost" className="text-danger" disabled={totpIsLastRequired || !securityReady} onClick={() => setDialog("totp_remove")}>
                    Turn off…
                  </Button>
                </div>
                {totpIsLastRequired ? (
                  <p className="text-xs text-on-surface-faint">Your organization requires two-step verification, so you cannot turn off your only second step.</p>
                ) : null}
              </>
            ) : (
              <Button
                className="self-start whitespace-normal text-left h-auto min-h-9"
                disabled={!securityReady}
                variant={hasFactor ? "outline" : "default"}
                // Every new factor needs fresh proof: the password when this is
                // the first one, a second factor when there is one already.
                onClick={() => { setStatus(null); setDialog("totp_start"); }}
              >
                Set up an authenticator app
              </Button>
            )}
          </div>

          <div className="flex min-w-0 flex-col gap-2">
            <h4 id="passkeys-heading" tabIndex={-1} className="text-base font-semibold text-on-surface">Passkeys</h4>
            <ReadNotice pending={config.isPending} failed={config.isError} fetching={config.isFetching} hasData={!!config.data}
              loading="Checking passkey availability…" unavailable="Passkey availability could not be loaded. Retry to check whether this installation offers passkeys."
              retained="Passkey availability could not be refreshed. Showing the last loaded passkey availability. Retry before changing passkeys."
              retryLabel="Retry passkey availability" retry={() => config.refetch()} focusId="passkeys-heading" />
            {config.data?.passkeys ? (
              <PasskeyList
                security={data}
                canChange={securityReady && !config.isError && !config.isFetching}
                onStatus={(message) => setStatus({ message, tone: "success" })}
                onFirstFactor={(codes) => showCodes(codes, "Your passkey is added.")}
                onChanged={() => void security.refetch()}
              />
            ) : config.data ? <p className="text-sm text-on-surface-variant">Passkeys are disabled for this installation.</p> : null}
          </div>
        </div>
      ) : null}

      <StepUpDialog
        open={dialog === "totp_start"}
        onOpenChange={(open) => { if (!open) setDialog(null); }}
        action="self.totp_replace"
        title={data.totpEnabled ? "Use a new phone" : "Set up an authenticator app"}
        description="Confirm it is you. You then scan a new QR code. Running agent work stops."
        confirmLabel="Continue"
        run={async (token) => { setMode({ kind: "enroll", stepUpToken: token }); }}
      />
      <StepUpDialog
        open={dialog === "codes"}
        onOpenChange={(open) => { if (!open) setDialog(null); }}
        action="self.recovery_codes"
        title="Make new recovery codes"
        description="Your old recovery codes stop working."
        confirmLabel="Make new codes"
        run={async (token) => { showCodes(await regenerateMyRecoveryCodes(token), "Your new recovery codes are ready."); }}
      />
      <StepUpDialog
        open={dialog === "totp_remove"}
        onOpenChange={(open) => { if (!open) setDialog(null); }}
        action="self.totp_remove"
        title="Turn off the authenticator app?"
        description="Its codes stop working, and you are signed out on every other device. Without another second step, your recovery codes stop working too. Running agent work stops."
        confirmLabel="Turn off"
        destructive
        run={async (token) => {
          const session = await removeMyTotp(token);
          await completeLogin(session.accessToken);
          setStatus({ message: "The authenticator app is turned off.", tone: "success" });
          void security.refetch();
        }}
      />
    </TwoStepSection>
  );
}

function PasskeyList({ security, canChange, onStatus, onFirstFactor, onChanged }: {
  security: MySecurityResponse;
  canChange: boolean;
  onStatus: (message: string) => void;
  onFirstFactor: (codes: string[]) => void;
  onChanged: () => void;
}) {
  const { adoptSession, completeLogin } = useAuth();
  const nameId = useId();
  const passkeys = useQuery({ queryKey: queryKeys.settings.passkeys(), queryFn: listMyPasskeys });
  const [name, setName] = useState("");
  const [dialog, setDialog] = useState<{ kind: "add" } | { kind: "remove"; passkey: PasskeySummary } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const renameDraft = useRef(renaming);
  const renameRequests = useRef(new Set<string>());
  const [renamingIds, setRenamingIds] = useState(new Set<string>());
  const [renameErrors, setRenameErrors] = useState<Record<string, { name: string; message: string } | undefined>>({});
  const renameForm = useRef<HTMLFormElement>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const renameButtons = useRef(new Map<string, HTMLButtonElement>());
  const renameFocus = useRef<{ id: string; target: "input" | "button"; owner: Element | null } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = passkeysSupported();
  const hasFactor = security.totpEnabled || security.passkeyCount > 0;
  const list = passkeys.data ?? [];
  const lastRequired = security.mfaRequired && !security.totpEnabled && security.passkeyCount === 1;
  const changesReady = canChange && passkeys.data !== undefined && !passkeys.isError && !passkeys.isFetching;

  const editRename = (draft: typeof renaming) => {
    renameDraft.current = draft;
    setRenaming(draft);
  };

  useEffect(() => {
    const intent = renameFocus.current;
    if (!intent) return;
    const active = document.activeElement;
    if (active !== intent.owner && !(active === document.body && !intent.owner?.isConnected)) {
      renameFocus.current = null;
      return;
    }
    const target = intent.target === "input" ? renameInput.current : renameButtons.current.get(intent.id);
    if (target?.disabled) return;
    renameFocus.current = null;
    target?.focus();
  }, [renaming, changesReady]);

  const add = async (stepUpToken: string) => {
    setPending(true);
    setError(null);
    try {
      const result = await addMyPasskey(name.trim() || defaultPasskeyName(), stepUpToken);
      if (result.recoveryCodes && result.accessToken && result.user) {
        // A first second factor ended every older session. Take the new one
        // before the lists load again, so that they use it.
        adoptSession(result.accessToken, result.user);
        onFirstFactor(result.recoveryCodes);
      } else {
        onStatus("Your passkey is added.");
      }
      setName("");
      void passkeys.refetch();
      onChanged();
    } catch (caught) {
      setError(localAuthMessage(caught, "The passkey could not be added. Try again."));
      // The dialog stays open with the error; a new try needs a new proof.
      throw caught;
    } finally {
      setPending(false);
    }
  };

  const rename = async () => {
    const sent = renameDraft.current;
    if (!sent || !sent.name.trim() || !changesReady || renameRequests.current.has(sent.id)) return;
    renameRequests.current.add(sent.id);
    setRenamingIds(new Set(renameRequests.current));
    setRenameErrors(current => ({ ...current, [sent.id]: undefined }));
    try {
      await renameMyPasskey(sent.id, sent.name);
      // A later edit, including a reopened editor for this row, owns its draft.
      if (renameDraft.current === sent) {
        if (renameForm.current?.contains(document.activeElement)) {
          renameFocus.current = { id: sent.id, target: "button", owner: document.activeElement };
        }
        editRename(null);
      }
      void passkeys.refetch();
    } catch (caught) {
      setRenameErrors(current => ({ ...current, [sent.id]: { name: sent.name, message: localAuthMessage(caught, "Try again.") } }));
    } finally {
      renameRequests.current.delete(sent.id);
      setRenamingIds(new Set(renameRequests.current));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-on-surface-variant">
        Sign in without a password, with this device&apos;s screen lock, a security key, or your password manager.
      </p>
      <ReadNotice pending={passkeys.isPending} failed={passkeys.isError} fetching={passkeys.isFetching} hasData={passkeys.data !== undefined}
        loading="Loading your passkeys…" unavailable="Your passkey list could not be loaded. Retry to see your registered passkeys."
        retained="Your passkey list could not be refreshed. Showing the last loaded passkey list. Retry before changing passkeys."
        retryLabel="Retry passkey list" retry={() => passkeys.refetch()} focusId="passkeys-heading" />
      {passkeys.isSuccess && list.length === 0 ? <p className="text-sm text-on-surface-variant">You have no passkeys yet.</p> : null}
      {list.length > 0 ? (
        <ul aria-label="Your passkeys" className="flex flex-col divide-y divide-outline-variant rounded-md border border-outline-variant">
          {list.map((passkey) => (
            <li key={passkey.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
              {renaming?.id === passkey.id ? (
                <form ref={renameForm} className="flex min-w-0 flex-1 flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void rename(); }}>
                  <Input ref={renameInput} className="min-w-0 basis-full sm:basis-0 sm:flex-1" aria-label="Passkey name" aria-describedby={renameErrors[passkey.id] ? `${nameId}-rename-${passkey.id}` : undefined} maxLength={64} value={renaming.name} onChange={(e) => editRename({ id: passkey.id, name: e.target.value })} />
                  <PendingButton type="submit" size="sm" pending={renamingIds.has(passkey.id)} pendingLabel="Saving…" disabled={!renaming.name.trim() || !changesReady}>Save</PendingButton>
                  <Button type="button" size="sm" variant="ghost" onClick={() => {
                    renameFocus.current = { id: passkey.id, target: "button", owner: document.activeElement };
                    editRename(null);
                  }}>Cancel</Button>
                </form>
              ) : (
                <>
                  <span className="min-w-0 flex-1 basis-full sm:basis-auto">
                    <span className="block break-words text-sm font-medium text-on-surface">{passkey.name}</span>
                    <span className="block text-xs text-on-surface-variant">
                      Added {formatDate(passkey.createdAt)}
                      {passkey.lastUsedAt ? `, last used ${formatDate(passkey.lastUsedAt)}` : ", not used yet"}
                      {passkey.backedUp ? ". Synced across devices." : "."}
                    </span>
                  </span>
                  <Button ref={button => { if (button) renameButtons.current.set(passkey.id, button); else renameButtons.current.delete(passkey.id); }} size="sm" variant="ghost" disabled={!changesReady} onClick={() => {
                    renameFocus.current = { id: passkey.id, target: "input", owner: document.activeElement };
                    editRename({ id: passkey.id, name: passkey.name });
                  }}>Rename</Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-danger"
                    disabled={lastRequired || !changesReady || renamingIds.has(passkey.id)}
                    onClick={() => { setError(null); setDialog({ kind: "remove", passkey }); }}
                  >
                    Remove…
                  </Button>
                </>
              )}
              {renamingIds.has(passkey.id) ? <p role="status" className="basis-full text-sm text-on-surface-variant">Saving the passkey name…</p> : null}
              {renameErrors[passkey.id] ? <p id={`${nameId}-rename-${passkey.id}`} role="alert" className="basis-full text-sm text-danger [overflow-wrap:anywhere]">Could not save &quot;{renameErrors[passkey.id]!.name}&quot;. {renameErrors[passkey.id]!.message}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {lastRequired ? (
        <p className="text-xs text-on-surface-faint">Your organization requires two-step verification, so you cannot remove your only second step.</p>
      ) : null}
      {supported ? (
        <form
          className="flex flex-wrap items-end gap-2"
          // Every new passkey needs fresh proof: the password when this is
          // the first factor, a second factor when there is one already.
          onSubmit={(e) => { e.preventDefault(); if (!changesReady) return; setError(null); setDialog({ kind: "add" }); }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={nameId}>Name (optional)</Label>
            <Input id={nameId} maxLength={64} placeholder={defaultPasskeyName()} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <Button type="submit" variant={hasFactor ? "outline" : "default"} disabled={pending || !changesReady} aria-busy={pending}>
            {pending ? "Waiting for the passkey…" : "Add a passkey"}
          </Button>
        </form>
      ) : (
        <p className="text-sm text-on-surface-variant">This browser cannot create passkeys.</p>
      )}
      {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}

      <StepUpDialog
        open={dialog?.kind === "add"}
        onOpenChange={(open) => { if (!open) setDialog(null); }}
        action="self.passkey_add"
        title="Add a passkey"
        description={`Confirm it is you. Your browser then asks you to create the passkey.${security.totpEnabled || security.passkeyCount > 0 ? "" : " Running agent work stops."}`}
        confirmLabel="Continue"
        run={(token) => add(token)}
      />
      <StepUpDialog
        open={dialog?.kind === "remove"}
        onOpenChange={(open) => { if (!open) setDialog(null); }}
        action="self.passkey_remove"
        title={dialog?.kind === "remove" ? `Remove "${dialog.passkey.name}"?` : "Remove the passkey?"}
        description="It stops working, and you are signed out on every other device. Without another second step, your recovery codes stop working too. Also delete it from the device or password manager that holds it. Running agent work stops."
        confirmLabel="Remove"
        destructive
        run={async (token) => {
          if (dialog?.kind !== "remove") return;
          const session = await removeMyPasskey(dialog.passkey.id, token);
          await completeLogin(session.accessToken);
          onStatus("The passkey is removed.");
          void passkeys.refetch();
          onChanged();
        }}
      />
    </div>
  );
}

/** A name that tells passkeys apart, until the person picks one. */
function defaultPasskeyName(): string {
  if (typeof navigator === "undefined") return "Passkey";
  const agent = navigator.userAgent;
  const platform = /iPhone|iPad/.test(agent) ? "iPhone or iPad" : /Android/.test(agent) ? "Android" : /Mac/.test(agent) ? "Mac" : /Windows/.test(agent) ? "Windows" : /Linux/.test(agent) ? "Linux" : "this device";
  return `Passkey on ${platform}`;
}

function SignOutEverywhere() {
  const { logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setPending(true);
    setError(null);
    try {
      await signOutEverywhere();
      await logout();
    } catch (caught) {
      setError(localAuthMessage(caught, "Could not sign out everywhere. Try again."));
      setPending(false);
    }
  };

  return (
    <section className="flex flex-col gap-2 border-t border-outline-variant pt-6">
      <h3 className={SECURITY_SECTION_HEADING}>Sign out everywhere</h3>
      <p className="text-sm text-on-surface-variant">Ends every session of your account, on every device, this one too.</p>
      <Button variant="outline" className="self-start" onClick={() => { setError(null); setOpen(true); }}>Sign out everywhere…</Button>
      <AlertDialog open={open} onOpenChange={(value) => { if (!pending) setOpen(value); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out on every device?</AlertDialogTitle>
            <AlertDialogDescription>You must sign in again here and on every other device. Running agent work stops.</AlertDialogDescription>
          </AlertDialogHeader>
          {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <Button variant="destructive" onClick={() => void confirm()} disabled={pending} aria-busy={pending}>
              {pending ? "Signing out…" : "Sign out everywhere"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

export function SecuritySection() {
  const security = useQuery({ queryKey: queryKeys.settings.security(), queryFn: fetchMySecurity });
  return (
    <div className="flex flex-col gap-6">
      <PasswordChange security={security} />
      <TwoStepVerification security={security} />
      <SignOutEverywhere />
    </div>
  );
}
