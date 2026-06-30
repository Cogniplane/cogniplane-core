"use client";

export const dynamic = "force-dynamic";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { API_URL } from "../../../lib/api-client";
import { useAuth } from "../../../lib/auth-context";
import { Button } from "@/components/ui/button";

type OrganizationOption = { id: string; name: string };

function AuthCallbackInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [organizations, setOrganizations] = useState<OrganizationOption[]>([]);
  const [isRedirecting, setIsRedirecting] = useState(false);
  const { completeLogin, login } = useAuth();

  useEffect(() => {
    const code = searchParams.get("code");
    const state = searchParams.get("state");
    if (!code) {
      // Synchronous validation of URL query params on mount; setState here is
      // a one-shot guard, not a sync loop.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setError("Missing authorization code");
      return;
    }
    if (!state) {
      setError("Missing authorization state");
      return;
    }

    (async () => {
      try {
        const response = await fetch(`${API_URL}/auth/callback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ code, state })
        });

        if (!response.ok) {
          const data = (await response.json()) as {
            error?: string;
            organizations?: OrganizationOption[];
          };
          if (
            response.status === 409 &&
            data.error === "organization_selection_required" &&
            data.organizations?.length
          ) {
            setOrganizations(data.organizations);
            return;
          }
          setError(data.error ?? "Authentication failed");
          return;
        }

        const data = (await response.json()) as { accessToken: string };
        const ok = await completeLogin(data.accessToken);
        if (!ok) {
          setError("Authentication succeeded but user bootstrap failed");
          return;
        }
        router.replace("/");
      } catch {
        setError("Authentication request failed");
      }
    })();
  }, [searchParams, router, completeLogin]);

  const selectOrganization = async (organizationId: string) => {
    setIsRedirecting(true);
    try {
      await login({ organization: organizationId });
    } catch {
      setIsRedirecting(false);
      setError("Could not restart sign in for that organization");
    }
  };

  if (organizations.length > 0) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <div className="w-full max-w-md rounded-2xl border border-outline-variant bg-surface p-8 shadow-sm">
          <h1 className="text-xl font-semibold text-on-surface">Choose an organization</h1>
          <p className="mt-2 text-sm text-on-surface-variant">
            Your account belongs to multiple organizations. Select the workspace to open.
          </p>
          <div className="mt-6 flex flex-col gap-3">
            {organizations.map((organization) => (
              <Button
                key={organization.id}
                type="button"
                variant="outline"
                disabled={isRedirecting}
                onClick={() => void selectOrganization(organization.id)}
                className="h-auto justify-start px-4 py-3 text-left"
              >
                <span className="flex flex-col items-start">
                  <span>{organization.name}</span>
                  <span className="text-xs font-normal text-on-surface-variant">
                    {organization.id}
                  </span>
                </span>
              </Button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-6">
        <p className="text-sm text-danger">{error}</p>
        <a href="/login" className="text-sm text-info hover:underline">Back to login</a>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background text-on-surface-variant">
      Completing sign in...
    </div>
  );
}

export default function AuthCallbackPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center bg-background text-on-surface-variant">Completing sign in...</div>}>
      <AuthCallbackInner />
    </Suspense>
  );
}
