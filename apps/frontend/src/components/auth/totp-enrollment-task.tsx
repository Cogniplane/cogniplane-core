"use client";

import { useState, type ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { TotpEnrollment } from "./totp-enrollment";

// Settings may cancel before confirmation. Keep a submitted result visible.
// After a failed start, Cancel is the only next step, so it becomes primary.
export function TotpEnrollmentTask({ onCancel, ...enrollment }: Omit<ComponentProps<typeof TotpEnrollment>, "onPendingChange" | "onStartFailed"> & { onCancel: () => void }) {
  const [pending, setPending] = useState(false);
  const [startFailed, setStartFailed] = useState(false);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <TotpEnrollment restartHint="Cancel this setup, then set up the app again." {...enrollment} onPendingChange={setPending} onStartFailed={setStartFailed} />
      <Button type="button" variant={startFailed ? "default" : "outline"} className="self-start" disabled={pending} onClick={onCancel}>Cancel</Button>
    </div>
  );
}
