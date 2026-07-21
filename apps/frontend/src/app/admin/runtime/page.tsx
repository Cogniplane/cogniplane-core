"use client";

import { useAdminRuntimeData } from "../../../hooks/use-admin-runtime-data";
import { AdminRuntimeCard } from "../../../components/admin/runtime/admin-runtime-card";

export default function AdminRuntimePage() {
  const {
    runtimeSessions,
    runtimeConfig,
    busyKey,
    error,
    handleDrainIdle,
    handleRefreshIdle
  } = useAdminRuntimeData();

  return (
    <section id="runtime" className="flex flex-col gap-5 pt-5">
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <AdminRuntimeCard
        runtimeSessions={runtimeSessions}
        runtimeConfig={runtimeConfig}
        busyKey={busyKey}
        onDrainIdle={handleDrainIdle}
        onRefreshIdle={handleRefreshIdle}
      />
    </section>
  );
}
