"use client";

import { Suspense } from "react";

import { LastAdminChange } from "../../../components/admin/history/history-widgets";

import { AdminPolicyEnforcement } from "../../../components/admin/policy/admin-policy-enforcement";
import { AdminPolicyDecisionsCard } from "../../../components/admin/policy/admin-policy-decisions-card";
import { AdminPolicyRulesCard } from "../../../components/admin/policy/admin-policy-rules-card";
import { AdminPolicySimulator } from "../../../components/admin/policy/admin-policy-simulator";
import { useDecisionsData, usePolicyData, usePolicyMonitorSummary } from "../../../hooks/use-policy-data";
import { useTenantSettings } from "../../../hooks/use-tenant-settings";

// The decision filters and the review link are read from the URL.
export default function AdminPolicyRoute() {
  return (
    <Suspense fallback={<p role="status" className="pt-6">Loading policies...</p>}>
      <AdminPolicyPage />
    </Suspense>
  );
}

function AdminPolicyPage() {
  const {
    rules,
    lintWarnings,
    busyKey,
    error,
    simulation,
    simulating,
    saveRule,
    deleteRule,
    reorderRules,
    runSimulation
  } = usePolicyData();

  const decisions = useDecisionsData();
  // Same cached queries as the mode row, so each rule can show its own Monitor counts.
  const { settings } = useTenantSettings();
  const monitoring = settings?.policyEnforcementMode === "monitor";
  const monitorSummary = usePolicyMonitorSummary({ enabled: monitoring });

  return (
    <section id="policy" className="flex flex-col gap-10 pt-5">
      <AdminPolicyEnforcement meta={<LastAdminChange section="policy" />} />
      {error ? <p className="text-sm text-danger">{error}</p> : null}

      <AdminPolicyRulesCard
        rules={rules}
        lintWarnings={lintWarnings}
        busyKey={busyKey}
        onSave={saveRule}
        onDelete={deleteRule}
        onReorder={reorderRules}
        // After a failed refresh the mode row says the numbers are old; the rows hide theirs.
        evidence={monitoring && !monitorSummary.isError ? monitorSummary.data : undefined}
      >
        <AdminPolicySimulator result={simulation} simulating={simulating} onSimulate={runSimulation} />
      </AdminPolicyRulesCard>

      <AdminPolicyDecisionsCard
        decisions={decisions.decisions}
        total={decisions.total}
        page={decisions.page}
        pageCount={decisions.pageCount}
        offset={decisions.offset}
        hasMore={decisions.hasMore}
        loading={decisions.loading}
        fetching={decisions.fetching}
        error={decisions.error}
        filters={decisions.filters}
        urlProblems={decisions.urlProblems}
        rules={rules}
        onApply={decisions.applyFilters}
        onNext={decisions.nextPage}
        onPrev={decisions.prevPage}
        onRefresh={decisions.refresh}
      />
    </section>
  );
}
