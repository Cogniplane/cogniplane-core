"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { MemberLinkResponse } from "@cogniplane/shared-types";

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
import { formatExpiry } from "./local-account.logic";

// The outcome of a new setup or reset link (docs/ARCHITECTURE.md,
// "Authentication"). With email on, the link went to the person and the
// manager sees only where it went. With email off, the link shows once: the
// backend stores only its hash, so the manager copies it now and sends it.
export function IssuedLinkDialog({ delivery, name, onClose }: { delivery: MemberLinkResponse | null; name: string; onClose: () => void }) {
  const [feedback, setFeedback] = useState<{ delivery: MemberLinkResponse | null; phase: "idle" | "pending" | "copied" | "failed" }>({ delivery, phase: "idle" });
  const request = useRef<object | null>(null);
  const feedbackId = useId();
  useEffect(() => () => { request.current = null; }, [delivery]);
  if (feedback.delivery !== delivery) setFeedback({ delivery, phase: "idle" });
  const phase = feedback.delivery === delivery ? feedback.phase : "idle";
  const link = delivery?.link ?? null;
  const email = delivery?.email ?? null;
  const isSetup = (link ?? email)?.purpose === "account_setup";
  const close = () => { request.current = null; setFeedback({ delivery, phase: "idle" }); onClose(); };

  const copy = async () => {
    if (!link || request.current) return;
    const attempt = {};
    request.current = attempt;
    setFeedback({ delivery, phase: "pending" });
    try {
      await navigator.clipboard.writeText(link.url);
      if (request.current === attempt) setFeedback({ delivery, phase: "copied" });
    } catch {
      if (request.current === attempt) setFeedback({ delivery, phase: "failed" });
    } finally {
      if (request.current === attempt) request.current = null;
    }
  };

  return (
    <Dialog open={delivery !== null} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent>
        {email ? (
          <>
            <DialogHeader>
              <DialogTitle>{isSetup ? `Setup link sent to ${name}` : `Password reset link sent to ${name}`}</DialogTitle>
              <DialogDescription>
                We emailed a one-time link to {email.to}. It works once and ends {formatExpiry(email.expiresAt)}.
                You can see on their page when the email has gone out.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button onClick={close}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{isSetup ? `Setup link for ${name}` : `Password reset link for ${name}`}</DialogTitle>
              <DialogDescription>
                Send this link to {name} in a private message. It works once
                {link ? ` and ends ${formatExpiry(link.expiresAt)}` : ""}. You cannot see it again after you close this window.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <Input readOnly value={link?.url ?? ""} aria-label="One-time link" aria-describedby={feedbackId} onFocus={(event) => event.currentTarget.select()} />
              <p id={feedbackId} role="status" aria-live="polite" className={`min-h-10 text-sm ${phase === "failed" ? "text-danger" : phase === "copied" ? "text-success" : "text-on-surface-variant"}`}>
                {phase === "failed" ? "Could not copy the link. Select the link above and copy it manually before you close this window." : phase === "copied" ? "Copied." : phase === "pending" ? "Copying the link…" : ""}
              </p>
              <p className="text-xs text-on-surface-variant">
                Anyone who has this link can set the password. Do not post it in a shared channel.
              </p>
            </div>
            <DialogFooter>
              <Button variant="outline" aria-disabled={phase === "pending"} aria-busy={phase === "pending"} onClick={() => void copy()}>{phase === "pending" ? "Copying…" : "Copy link"}</Button>
              <Button onClick={close}>Done</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
