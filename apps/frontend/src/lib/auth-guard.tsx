"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircleIcon } from "lucide-react";

import { useAuth, type AuthUser } from "./auth-context";

type Role = AuthUser["role"];

export function AuthGuard({
  children,
  requiredRoles
}: {
  children: ReactNode;
  requiredRoles?: Role[];
}) {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  const authorized = !requiredRoles || (user !== null && requiredRoles.includes(user.role));

  useEffect(() => {
    if (isLoading) return;
    if (!user) {
      router.replace("/login");
      return;
    }
    if (!authorized) {
      router.replace("/");
    }
  }, [user, isLoading, authorized, router]);

  if (isLoading) {
    return (
      <div role="status" className="flex min-h-dvh items-center justify-center gap-2 bg-background text-sm text-on-surface-variant">
        <LoaderCircleIcon aria-hidden="true" className="size-4 text-brand motion-safe:animate-spin" />
        Checking your session…
      </div>
    );
  }

  if (!user || !authorized) {
    return null;
  }

  return <>{children}</>;
}
