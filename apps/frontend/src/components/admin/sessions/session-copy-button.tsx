"use client";

import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

export function SessionCopyButton(props: { value: string; label: string; children?: string; size?: "xs" | "sm" }) {
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const [pending, setPending] = useState(false);
  const running = useRef(false);
  const feedbackId = useId();
  const copy = async () => {
    if (running.current) return;
    running.current = true;
    setPending(true);
    setFeedback(null);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("unavailable");
      await navigator.clipboard.writeText(props.value);
      setFeedback({ error: false, text: "Copied to clipboard." });
    } catch {
      setFeedback({ error: true, text: "Could not copy. Select the text and copy it manually." });
    } finally {
      running.current = false;
      setPending(false);
    }
  };
  return <div className="flex max-w-full flex-col items-start gap-1">
    <Button type="button" variant="ghost" size={props.size ?? "xs"} aria-label={props.label} aria-busy={pending} aria-disabled={pending} aria-describedby={feedback ? feedbackId : undefined} onClick={() => void copy()}>{props.children ?? "Copy"}</Button>
    {feedback ? <p id={feedbackId} role={feedback.error ? "alert" : "status"} className={`max-w-prose text-sm ${feedback.error ? "text-danger" : "text-on-surface-variant"}`}>{feedback.text}</p> : null}
  </div>;
}
