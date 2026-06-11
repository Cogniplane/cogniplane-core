"use client";

import { useAdminRuntimeData } from "../../../hooks/use-admin-runtime-data";
import { AdminRuntimeCard } from "../../../components/admin/runtime/admin-runtime-card";
import { SECTION_LABEL } from "../../../lib/ui-tokens";

export default function AdminRuntimePage() {
  const {
    runtimeSessions,
    runtimeConfig,
    runtimeDiagnostic,
    busyKey,
    error,
    handleDrainIdle,
    handleRefreshIdle,
    handleRunDiagnostic
  } = useAdminRuntimeData();

  return (
    <section id="runtime" className="flex flex-col gap-5">
      <div>
        <p className={SECTION_LABEL}>Operations</p>
        <h3 className="text-lg font-semibold text-on-surface">Runtime rollout</h3>
      </div>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <AdminRuntimeCard
        runtimeSessions={runtimeSessions}
        runtimeConfig={runtimeConfig}
        runtimeDiagnostic={runtimeDiagnostic}
        busyKey={busyKey}
        onDrainIdle={handleDrainIdle}
        onRefreshIdle={handleRefreshIdle}
        onRunRuntimeDiagnostic={handleRunDiagnostic}
      />
    </section>
  );
}
