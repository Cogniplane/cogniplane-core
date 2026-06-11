"use client";

import { AdminPolicyDecisionsCard } from "../../../components/admin/policy/admin-policy-decisions-card";
import { AdminPolicyRulesCard } from "../../../components/admin/policy/admin-policy-rules-card";
import { AdminPolicySimulator } from "../../../components/admin/policy/admin-policy-simulator";
import { useDecisionsData, usePolicyData } from "../../../hooks/use-policy-data";
import { SECTION_LABEL } from "../../../lib/ui-tokens";

export default function AdminPolicyPage() {
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

  return (
    <section id="policy" className="flex flex-col gap-5">
      <div>
        <p className={SECTION_LABEL}>Governance</p>
        <h3 className="text-lg font-semibold text-on-surface">Policy Center</h3>
        <p className="mt-1 max-w-prose text-sm text-on-surface-variant">
          Rules are evaluated at the MCP gateway for every agent tool action. Whether matching rules
          actually gate is the tenant-level enforcement mode in Agent settings — until it&rsquo;s set
          to enforce, rules only record decisions you can review below.
        </p>
      </div>
      {error ? <p className="text-sm text-danger">{error}</p> : null}

      <AdminPolicyRulesCard
        rules={rules}
        lintWarnings={lintWarnings}
        busyKey={busyKey}
        onSave={saveRule}
        onDelete={deleteRule}
        onReorder={reorderRules}
      />

      <AdminPolicySimulator result={simulation} simulating={simulating} onSimulate={runSimulation} />

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
        onApply={decisions.applyFilters}
        onNext={decisions.nextPage}
        onPrev={decisions.prevPage}
        onRefresh={decisions.refresh}
      />
    </section>
  );
}
