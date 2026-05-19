"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";

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
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh" }}>
        Loading...
      </div>
    );
  }

  if (!user || !authorized) {
    return null;
  }

  return <>{children}</>;
}
