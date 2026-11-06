"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { AuthFrame } from "./auth-frame";
import { AuthMessage, focusIfOwned } from "./auth-ui";

/** Setup consumes its link; sign-in can reload without using a setup link again. */
export function WorkspaceLoadFailure({ onReload }: { onReload?: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { focusIfOwned(heading.current); }, []);
  return (
    <AuthFrame title="Workspace did not load" headingRef={heading}>
      <div className="flex flex-col gap-4">
        <AuthMessage tone="error">Sign-in completed, but your workspace details could not load.</AuthMessage>
        {onReload ? (
          <Button onClick={onReload}>Reload the page</Button>
        ) : (
          <>
            <p className="text-sm text-on-surface-variant">Your password is saved. The setup link has been used, so continue from sign-in.</p>
            <Button asChild><a href="/login">Go to sign-in</a></Button>
          </>
        )}
      </div>
    </AuthFrame>
  );
}
