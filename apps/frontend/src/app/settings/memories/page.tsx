"use client";

import { MemoriesSection } from "@/components/memories-section";
import { useAuth } from "@/lib/auth-context";

export default function SettingsMemoriesPage() {
  const { user } = useAuth();
  if (!user) return null;
  // Remount on a change of account, so no state carries over to another user or organization.
  return <MemoriesSection key={`${user.tenantId}:${user.userId}`} scope={{ tenantId: user.tenantId, userId: user.userId }} />;
}
