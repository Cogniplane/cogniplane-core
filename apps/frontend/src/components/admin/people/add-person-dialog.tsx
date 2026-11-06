"use client";

import { useId, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { CreateLocalMemberRequest, MemberLinkResponse } from "@cogniplane/shared-types";

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
import { createLocalMember, isStepUpRefusal, localAuthMessage } from "../../../lib/local-auth-api";
import { queryKeys } from "../../../lib/query-keys";
import { IssuedLinkDialog } from "./issued-link-dialog";
import { newPersonRoles } from "./local-account.logic";
import { ROLE_INFO, type Actor, type MemberRole } from "./person-access.logic";
import { StepUpDialog } from "./step-up-dialog";

// Adds a person to a tenant with local login. With email on, the setup link
// goes to the person by email; otherwise the manager gets it to send. A new
// account needs the manager's step-up: the form comes first, then the proof,
// then the request. A refusal about the form opens the form again, with the
// values the manager typed.
export function AddPersonButton({ actor }: { actor: Actor }) {
  const queryClient = useQueryClient();
  const emailId = useId();
  const nameId = useId();
  const roleId = useId();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<MemberRole>("member");
  const [error, setError] = useState<string | null>(null);
  // The form's request, while the step-up dialog asks for the proof.
  const [confirming, setConfirming] = useState<CreateLocalMemberRequest | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [link, setLink] = useState<{ delivery: MemberLinkResponse; name: string } | null>(null);
  const roles = newPersonRoles(actor);

  const reset = () => {
    setEmail("");
    setName("");
    setRole("member");
    setError(null);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setConfirming({ email, displayName: name.trim() || undefined, role });
    setOpen(false);
    setStepUpOpen(true);
  };

  const create = async (stepUpToken: string) => {
    if (!confirming) return;
    try {
      const created = await createLocalMember(confirming, stepUpToken);
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.users() });
      setLink({ delivery: { link: created.link, email: created.email }, name: confirming.displayName || confirming.email });
      reset();
    } catch (caught) {
      // A refused proof stays in the step-up dialog, to try again.
      if (isStepUpRefusal(caught)) throw caught;
      setError(localAuthMessage(caught, "The person could not be added. Try again."));
      setOpen(true);
    }
  };

  return (
    <>
      <Button size="sm" onClick={() => { reset(); setOpen(true); }}>Add person</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Add a person</DialogTitle>
              <DialogDescription>They get a one-time setup link and choose their own password.</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={emailId}>Email</Label>
              <Input id={emailId} type="email" required autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={nameId}>Name (optional)</Label>
              <Input id={nameId} type="text" maxLength={200} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={roleId}>Role</Label>
              <select
                id={roleId}
                value={role}
                onChange={(e) => setRole(e.target.value as MemberRole)}
                disabled={roles.length === 1}
                className="h-9 rounded-md border border-input bg-transparent px-3 text-sm text-on-surface"
              >
                {roles.map((choice) => <option key={choice} value={choice}>{ROLE_INFO[choice].label}</option>)}
              </select>
              <p className="text-xs text-on-surface-variant">{ROLE_INFO[role].summary}</p>
            </div>
            {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit">Add person</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <StepUpDialog
        open={stepUpOpen}
        onOpenChange={setStepUpOpen}
        action="member.create"
        title={`Add ${confirming?.displayName || confirming?.email || "this person"}?`}
        description={`They get an account with the ${ROLE_INFO[confirming?.role ?? "member"].label.toLowerCase()} role and a one-time setup link.`}
        confirmLabel="Add person"
        run={create}
      />
      <IssuedLinkDialog delivery={link?.delivery ?? null} name={link?.name ?? ""} onClose={() => setLink(null)} />
    </>
  );
}
