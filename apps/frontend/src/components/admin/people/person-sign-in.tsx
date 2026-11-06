"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdminUser, MemberLinkResponse } from "@cogniplane/shared-types";

import { Button } from "@/components/ui/button";
import {
  disableMember,
  enableMember,
  fetchAuthConfig,
  localAuthMessage,
  resendMemberLink,
  resetMemberMfa,
  resetMemberPassword,
  signOutMember
} from "../../../lib/local-auth-api";
import { queryKeys } from "../../../lib/query-keys";
import { IssuedLinkDialog } from "./issued-link-dialog";
import {
  ACCOUNT_STATUS_INFO,
  accountStatusOf,
  formatExpiry,
  linkEmailSummary,
  mayResendLink,
  signInLockReason
} from "./local-account.logic";
import { displayName, type Actor } from "./person-access.logic";
import { StepUpDialog } from "./step-up-dialog";

const ROW = "flex flex-col gap-2 py-4";
const ROW_LABEL = "text-xs font-semibold uppercase tracking-wide text-on-surface-variant";

// The Sign-in row of a person's Access panel, for local accounts only
// (docs/ARCHITECTURE.md, "Authentication").
export function PersonSignIn({ person, actor, onStatus }: { person: AdminUser; actor: Actor; onStatus: (message: string) => void }) {
  const queryClient = useQueryClient();
  const status = accountStatusOf(person);
  const name = displayName(person);
  const [resetOpen, setResetOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [mfaResetOpen, setMfaResetOpen] = useState(false);
  const [enableOpen, setEnableOpen] = useState(false);
  const [link, setLink] = useState<MemberLinkResponse | null>(null);
  // With email on, links go to the person, not to the manager.
  const configQuery = useQuery({ queryKey: queryKeys.auth.config(), queryFn: fetchAuthConfig, retry: 1 });
  const emailOn = configQuery.data?.passwordRecovery ?? false;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!status) return null;
  const lock = signInLockReason(actor, person);
  const refreshPeople = () => queryClient.invalidateQueries({ queryKey: queryKeys.admin.users() });

  /** `done`: the message, or a function of the work's result that makes it. */
  const simple = async <T,>(work: () => Promise<T>, done: string | ((result: T) => string), failure: string) => {
    setPending(true);
    setError(null);
    try {
      const result = await work();
      await refreshPeople();
      onStatus(typeof done === "function" ? done(result) : done);
    } catch (caught) {
      setError(localAuthMessage(caught, failure));
    } finally {
      setPending(false);
    }
  };

  return (
    <section aria-label="Sign-in" className={ROW}>
      <h4 className={ROW_LABEL}>Sign-in</h4>
      <p className="text-base font-semibold text-on-surface">{ACCOUNT_STATUS_INFO[status].label}</p>
      <p className="text-sm text-on-surface-variant">{ACCOUNT_STATUS_INFO[status].summary}</p>
      {status === "active" ? (
        <p className="text-sm text-on-surface-variant">
          Two-step verification: {person.mfaEnabled ? "on" : "off"}
          {person.passkeyCount ? ` (${person.passkeyCount} ${person.passkeyCount === 1 ? "passkey" : "passkeys"})` : ""}.
        </p>
      ) : null}
      {person.linkEmail && status !== "disabled" ? (
        <p className={person.linkEmail.status === "failed" ? "text-sm text-danger" : "text-sm text-on-surface-variant"}>
          {linkEmailSummary(person.linkEmail)}
        </p>
      ) : null}
      {lock ? (
        <p className="text-xs text-on-surface-faint">{lock}</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {status !== "disabled" ? (
            <Button variant="outline" size="sm" disabled={pending} onClick={() => setResetOpen(true)}>
              {status === "pending_setup" ? "New setup link…" : "Reset password…"}
            </Button>
          ) : null}
          {emailOn && mayResendLink(status, person.linkEmail) ? (
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => void simple(
                () => resendMemberLink(person.userId),
                (sent) => `We emailed a new link to ${sent.to}. It ends ${formatExpiry(sent.expiresAt)}.`,
                "Could not send the link."
              )}
            >
              Send the link again
            </Button>
          ) : null}
          {status === "active" ? (
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => void simple(() => signOutMember(person.userId), `${name} is signed out on every device.`, "Could not sign them out.")}
            >
              Sign out everywhere
            </Button>
          ) : null}
          {status === "active" && person.mfaEnabled ? (
            <Button variant="outline" size="sm" disabled={pending} onClick={() => setMfaResetOpen(true)}>
              Reset two-step verification…
            </Button>
          ) : null}
          {status === "disabled" ? (
            <Button variant="outline" size="sm" disabled={pending} onClick={() => setEnableOpen(true)}>
              Enable account…
            </Button>
          ) : (
            <Button variant="ghost" size="sm" className="text-danger hover:bg-danger-surface hover:text-danger" disabled={pending} onClick={() => setDisableOpen(true)}>
              Disable account…
            </Button>
          )}
        </div>
      )}
      {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}

      <StepUpDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        action="member.password_reset"
        title={status === "pending_setup" ? `New setup link for ${name}` : `Reset ${name}'s password`}
        description={
          status === "pending_setup"
            ? emailOn
              ? "The old setup link stops working. We email them a new one."
              : "The old setup link stops working. You get a new one to send."
            : emailOn
              ? "All of their sessions end now. We email them a one-time link; their current password works until they use it."
              : "All of their sessions end now. You get a one-time link to send them; their current password works until they use it."
        }
        confirmLabel={emailOn ? "Send the link" : "Get the link"}
        run={async (token) => {
          setLink(await resetMemberPassword(person.userId, token));
          await refreshPeople();
        }}
      />
      <StepUpDialog
        open={disableOpen}
        onOpenChange={setDisableOpen}
        action="member.disable"
        title={`Disable ${name}'s account?`}
        description="They cannot sign in, all of their sessions end, running agent work stops, and their scheduled jobs are turned off. You can enable the account again later."
        confirmLabel="Disable account"
        destructive
        run={async (token) => {
          await disableMember(person.userId, token);
          await refreshPeople();
          onStatus(`${name}'s account is disabled.`);
        }}
      />
      <StepUpDialog
        open={enableOpen}
        onOpenChange={setEnableOpen}
        action="member.enable"
        title={`Enable ${name}'s account?`}
        description="Their password works again. An account that was not set up needs a new setup link. Their scheduled jobs stay off until they turn them on."
        confirmLabel="Enable account"
        run={async (token) => {
          const next = await enableMember(person.userId, token);
          await refreshPeople();
          onStatus(next === "active" ? `${name} can sign in again.` : `${name}'s account is enabled. Send them a new setup link.`);
        }}
      />
      <StepUpDialog
        open={mfaResetOpen}
        onOpenChange={setMfaResetOpen}
        action="member.mfa_reset"
        title={`Reset ${name}'s two-step verification?`}
        description="Their authenticator app, passkeys, and recovery codes stop working, and all of their sessions end. At their next sign-in, they must set up a second step again. Do this only when you are sure who asked for it."
        confirmLabel="Reset"
        destructive
        run={async (token) => {
          await resetMemberMfa(person.userId, token);
          await refreshPeople();
          onStatus(`${name} must set up two-step verification at their next sign-in.`);
        }}
      />
      <IssuedLinkDialog delivery={link} name={name} onClose={() => setLink(null)} />
    </section>
  );
}
