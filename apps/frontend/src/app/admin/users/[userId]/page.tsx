"use client";

import { useParams } from "next/navigation";

import { PersonWorkbench } from "../../../../components/admin/people/person-workbench";

function decodeParam(value: string | undefined): string {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export default function AdminPersonPage() {
  const params = useParams<{ userId: string }>();
  const userId = decodeParam(params?.userId);
  // A new key per person drops dialog and mutation state from the previous one.
  return <PersonWorkbench key={userId} userId={userId} />;
}
