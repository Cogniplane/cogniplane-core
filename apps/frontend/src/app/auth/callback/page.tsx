"use client";

export const dynamic = "force-dynamic";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { API_URL } from "../../../lib/api-client";
import { useAuth } from "../../../lib/auth-context";

function AuthCallbackInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const { completeLogin } = useAuth();

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
          const data = (await response.json()) as { error?: string };
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

  if (error) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100vh", gap: "1rem" }}>
        <p style={{ color: "red" }}>{error}</p>
        <a href="/login">Back to login</a>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh" }}>
      Completing sign in...
    </div>
  );
}

export default function AuthCallbackPage() {
  return (
    <Suspense fallback={<div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh" }}>Completing sign in...</div>}>
      <AuthCallbackInner />
    </Suspense>
  );
}
