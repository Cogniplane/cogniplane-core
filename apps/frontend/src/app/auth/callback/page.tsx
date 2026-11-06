"use client";

export const dynamic = "force-dynamic";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { exchangeCodeOnce, type OrganizationOption } from "../../../lib/auth-callback-exchange";
import { useAuth } from "../../../lib/auth-context";
import { CallbackView, ORGANIZATION_RESTART_ERROR } from "../../../components/auth/callback-view";

function AuthCallbackInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [organizations, setOrganizations] = useState<OrganizationOption[]>([]);
  const [selectedOrganization, setSelectedOrganization] = useState<string | null>(null);
  const [isRedirecting, setIsRedirecting] = useState(false);
  // A synchronous guard: a second choice in the same frame cannot start a second login.
  const restarting = useRef(false);
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

    // The code is single-use, and this page can mount more than once for it.
    // All mounts share one exchange (lib/auth-callback-exchange.ts); only a
    // page that is still mounted acts on its outcome.
    let mounted = true;
    void exchangeCodeOnce(code, state, completeLogin).then((outcome) => {
      if (!mounted) return;
      switch (outcome.kind) {
        // Both outcomes go home. The home page checks the current session.
        case "signed_in":
        case "already_used":
          router.replace("/");
          return;
        case "select_organization":
          setOrganizations(outcome.organizations);
          return;
        case "failed":
          setError(outcome.message);
      }
    });
    return () => {
      mounted = false;
    };
  }, [searchParams, router, completeLogin]);

  const selectOrganization = async (organizationId: string) => {
    if (restarting.current) return;
    restarting.current = true;
    setError(null);
    setSelectedOrganization(organizationId);
    setIsRedirecting(true);
    try {
      await login({ organization: organizationId });
    } catch {
      restarting.current = false;
      setIsRedirecting(false);
      setError(ORGANIZATION_RESTART_ERROR);
    }
  };

  return <CallbackView organizations={organizations} error={error} isRedirecting={isRedirecting} selectedOrganization={selectedOrganization} selectOrganization={selectOrganization} />;
}

export default function AuthCallbackPage() {
  return (
    <Suspense fallback={<CallbackView organizations={[]} error={null} isRedirecting={false} selectOrganization={async () => {}} />}>
      <AuthCallbackInner />
    </Suspense>
  );
}
