"use client";

import { useId } from "react";
import type { OrganizationOption } from "../../lib/auth-callback-exchange";
import { AuthFrame } from "./auth-frame";
import { AuthLink, AuthMessage, PendingButton } from "./auth-ui";
import { Button } from "@/components/ui/button";

// Callback failures that a new sign-in does not fix. Other failures keep the
// reason beside the retry advice, so support can see it.
const CALLBACK_FAILURES: Record<string, string> = {
  email_required: "Your sign-in provider did not share an email address. Ask your administrator to add one to your account.",
  no_organization: "Your account does not belong to an organization. Ask your administrator to invite you.",
  wrong_login_type: "Your organization signs in with email and password. Go back and sign in with your password.",
  email_in_use: "Another account already uses this email address. Ask your administrator for help.",
  membership_removed: "An owner or admin removed you from this organization. Ask them if you need access again."
};
const failureText = (error: string) => CALLBACK_FAILURES[error] ?? `We could not finish signing you in (${error}). Start a new sign-in to continue.`;

/** The message beside an organization whose sign-in did not start. */
export const ORGANIZATION_RESTART_ERROR = "Sign-in could not start for that organization. Choose an organization to try again.";

export function CallbackView({ organizations, error, isRedirecting, selectedOrganization, selectOrganization }: {
  organizations: OrganizationOption[];
  error: string | null;
  isRedirecting: boolean;
  selectedOrganization?: string | null;
  selectOrganization: (organizationId: string) => Promise<void>;
}) {
  const errorId = useId();
  if (organizations.length > 0) {
    const selectedIsListed = organizations.some(organization => organization.id === selectedOrganization);
    return (
      <AuthFrame title="Choose an organization">
        <p className="text-sm text-on-surface-variant">Your account belongs to multiple organizations. Choose the workspace to open.</p>
        {error && !selectedIsListed ? <AuthMessage tone="error" className="mt-5">{error}</AuthMessage> : null}
        <ul className="mt-5 flex flex-col gap-3" aria-label="Organizations">
          {organizations.map(organization => {
            const selected = selectedOrganization === organization.id;
            const owner = isRedirecting && selected;
            const failed = !!error && selected;
            return (
              <li key={organization.id} className="flex min-w-0 flex-col gap-2">
                {/* The chosen organization keeps focus while its sign-in starts; the others wait. */}
                <PendingButton
                  type="button"
                  variant="outline"
                  pending={owner}
                  reserveIconSpace
                  disabled={isRedirecting}
                  aria-describedby={failed ? errorId : undefined}
                  onClick={() => void selectOrganization(organization.id)}
                  className="h-auto min-w-0 items-start justify-start whitespace-normal px-4 py-3 text-left [&>svg]:mt-0.5"
                >
                  <span className="flex min-w-0 flex-col items-start gap-1 [overflow-wrap:anywhere]">
                    <span>{organization.name}</span>
                    <span className="text-xs font-normal text-on-surface-variant">{organization.id}</span>
                  </span>
                </PendingButton>
                {owner ? <AuthMessage tone="note">Opening the selected organization's sign-in page…</AuthMessage> : null}
                {failed ? <AuthMessage tone="error" id={errorId}>{error}</AuthMessage> : null}
              </li>
            );
          })}
        </ul>
        <AuthLink href="/login" document className="mt-6">Back to sign-in</AuthLink>
      </AuthFrame>
    );
  }
  return (
    <AuthFrame title={error ? "Sign-in could not finish" : "Completing sign-in"}>
      {error ? (
        <div className="flex flex-col gap-5">
          <AuthMessage tone="error">{failureText(error)}</AuthMessage>
          <Button asChild><a href="/login">Back to sign-in</a></Button>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          <AuthMessage tone="progress">Please wait while we open your workspace…</AuthMessage>
          {/* A full page load leaves this page, so a stopped wait has a way out. */}
          <AuthLink href="/login" document>Back to sign-in</AuthLink>
        </div>
      )}
    </AuthFrame>
  );
}
