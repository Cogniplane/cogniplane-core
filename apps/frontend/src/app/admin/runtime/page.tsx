"use client";

import { useAdminRuntimeData } from "../../../hooks/use-admin-runtime-data";
import { AdminRuntimeCard } from "../../../components/admin/runtime/admin-runtime-card";

export default function AdminRuntimePage() {
  const runtime = useAdminRuntimeData();
  return <section id="runtime" className="pt-5"><AdminRuntimeCard {...runtime} /></section>;
}
