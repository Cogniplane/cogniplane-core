"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { PeopleDirectory, personHref } from "../../../components/admin/people/people-directory";

export default function AdminUsersPage() {
  const router = useRouter();
  // Older links (for example from Privacy activity) point at `?userId=`.
  // Send them to that person's page instead of the directory.
  const legacyUserId = useSearchParams().get("userId");

  useEffect(() => {
    if (legacyUserId) router.replace(personHref(legacyUserId));
  }, [legacyUserId, router]);

  if (legacyUserId) return <p role="status" className="pt-5 text-sm text-on-surface-faint">Opening person…</p>;
  return <PeopleDirectory />;
}
