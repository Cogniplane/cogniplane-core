"use client";

import { SecuritySection } from "@/components/security-section";
import { useAuth } from "@/lib/auth-context";

export default function SettingsSecurityPage() {
  const { user } = useAuth();
  if (!user) return null;
  if (user.loginType !== "local") {
    return <p className="text-sm text-on-surface-variant">Your organization manages sign-in through its identity provider.</p>;
  }
  // Remount on a change of account, so no state carries over to another user.
  return <SecuritySection key={`${user.tenantId}:${user.userId}`} />;
}
