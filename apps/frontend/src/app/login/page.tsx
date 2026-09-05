"use client";

import Image from "next/image";
import { useState, type FormEvent } from "react";

import { useAuth } from "../../lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function LoginPage() {
  const { login } = useAuth();
  const [ssoOrg, setSsoOrg] = useState("");
  const [isRedirecting, setIsRedirecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // `login()` navigates away on success, so this only ever returns on failure —
  // and the button has to come back or the page is stuck on "Redirecting…".
  const startLogin = async (options?: { organization?: string }) => {
    setError(null);
    setIsRedirecting(true);
    try {
      await login(options);
    } catch (caught) {
      setIsRedirecting(false);
      setError(caught instanceof Error ? caught.message : "Sign-in is unavailable right now.");
    }
  };

  const handleEmailLogin = async (e: FormEvent) => {
    e.preventDefault();
    await startLogin();
  };

  const handleSsoLogin = async (e: FormEvent) => {
    e.preventDefault();
    if (!ssoOrg.trim()) return;
    await startLogin({ organization: ssoOrg.trim() });
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background p-6">
      {/* Soft brand glow so the login screen reads as Cogniplane, not a generic form. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-40 left-1/2 h-[420px] w-[720px] -translate-x-1/2 rounded-full bg-brand-surface blur-3xl"
      />
      <div className="page-enter relative w-full max-w-md rounded-2xl border border-outline-variant bg-surface-container-lowest p-10 shadow-lg">
        <div className="mb-6 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
          <div
            className="flex size-[84px] flex-none items-center justify-center rounded-3xl bg-surface-bright shadow-[inset_0_0_0_1px_var(--color-outline-variant)]"
          >
            <Image
              src="/brand/cogniplane.svg"
              alt="Cogniplane logo"
              width={72}
              height={72}
              priority
            />
          </div>
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold text-on-surface">Cogniplane</h1>
            <p className="mt-1 text-sm text-on-surface-variant">Sign in to your workspace</p>
          </div>
        </div>

        {error ? (
          <p role="alert" className="mb-4 text-sm text-danger">
            {error}
          </p>
        ) : null}

        <form onSubmit={handleEmailLogin} className="flex flex-col gap-3">
          <Button type="submit" disabled={isRedirecting} className="w-full">
            {isRedirecting ? "Redirecting…" : "Sign in with Email"}
          </Button>
        </form>

        <div className="my-6 flex items-center gap-4 text-xs uppercase tracking-wide text-on-surface-faint">
          <span className="h-px flex-1 bg-outline-variant" />
          <span>or</span>
          <span className="h-px flex-1 bg-outline-variant" />
        </div>

        <form onSubmit={handleSsoLogin} className="flex flex-col gap-3">
          <Input
            type="text"
            aria-label="Organization ID or slug"
            placeholder="Organization ID or slug"
            value={ssoOrg}
            onChange={(e) => setSsoOrg(e.target.value)}
          />
          <Button
            type="submit"
            variant="outline"
            disabled={isRedirecting || !ssoOrg.trim()}
            className="w-full"
          >
            Sign in with SSO
          </Button>
        </form>
      </div>
    </div>
  );
}
