"use client";

import { useMemo, useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import type {
  PolicyDecisionsListResponse,
  PolicyLintWarning,
  PolicyRule,
  PolicyRuleInput,
  PolicySimulateRequest,
  PolicySimulateResponse
} from "@cogniplane/shared-types";
import { POLICY_DECISIONS_PAGE_SIZE } from "@cogniplane/shared-types";

import {
  decisionFiltersKey,
  parseDecisionUrl,
  writeDecisionUrl,
  type DecisionFilters
} from "../components/admin/policy/admin-policy-decision-url";
import {
  createPolicyRule,
  deletePolicyRule,
  getPolicyDecision,
  getPolicyMonitorSummary,
  listPolicyDecisions,
  listPolicyLintWarnings,
  listPolicyRules,
  reorderPolicyRules,
  simulatePolicy,
  updatePolicyRule,
  type PolicyDecisionsListParams
} from "../lib/admin-api";
import { toErrorMessage } from "../lib/error-utils";
import { queryKeys } from "../lib/query-keys";

export function usePolicyData() {
  const queryClient = useQueryClient();
  const rulesKey = queryKeys.admin.policyRules();
  const lintKey = queryKeys.admin.policyLint();
  // A rule mutation can change which rules are unreachable, so refresh the lint
  // alongside the rules every time. The monitor summary shows current rule
  // names and status.
  const invalidateRules = () => {
    void queryClient.invalidateQueries({ queryKey: rulesKey });
    void queryClient.invalidateQueries({ queryKey: lintKey });
    void queryClient.invalidateQueries({ queryKey: queryKeys.admin.policyMonitorSummary() });
    void queryClient.invalidateQueries({ queryKey: queryKeys.admin.history() });
  };

  const rulesQuery = useQuery({
    queryKey: rulesKey,
    queryFn: listPolicyRules
  });

  const lintQuery = useQuery({
    queryKey: lintKey,
    queryFn: listPolicyLintWarnings
  });

  const submitMutation = useMutation({
    mutationFn: (vars: { ruleId: string | null; input: PolicyRuleInput }) =>
      vars.ruleId ? updatePolicyRule(vars.ruleId, vars.input) : createPolicyRule(vars.input),
    onSuccess: () => invalidateRules()
  });

  const deleteMutation = useMutation({
    mutationFn: (ruleId: string) => deletePolicyRule(ruleId),
    onSuccess: () => invalidateRules()
  });

  // Reorder is optimistic: paint the new order immediately, roll back the cached
  // rules to the pre-drag snapshot on error, and refetch rules + lint on settle
  // so the server's renumbered priorities (and any new shadow warnings) win.
  const reorderMutation = useMutation<
    PolicyRule[],
    unknown,
    string[],
    { previous: PolicyRule[] | undefined }
  >({
    mutationFn: (ruleIds) => reorderPolicyRules(ruleIds),
    onMutate: async (ruleIds) => {
      await queryClient.cancelQueries({ queryKey: rulesKey });
      const previous = queryClient.getQueryData<PolicyRule[]>(rulesKey);
      if (previous) {
        const byId = new Map(previous.map((rule) => [rule.ruleId, rule]));
        const reordered = ruleIds
          .map((id) => byId.get(id))
          .filter((rule): rule is PolicyRule => Boolean(rule));
        queryClient.setQueryData<PolicyRule[]>(rulesKey, reordered);
      }
      return { previous };
    },
    onError: (_error, _ruleIds, context) => {
      if (context?.previous) queryClient.setQueryData(rulesKey, context.previous);
    },
    onSettled: () => invalidateRules()
  });

  const simulateMutation = useMutation<PolicySimulateResponse, unknown, PolicySimulateRequest>({
    mutationFn: (input) => simulatePolicy(input)
  });

  // The page has one error banner. It shows the result of the action the user
  // started last: a new action clears the old error, and an older action that
  // fails later does not replace the newer action's result.
  const actions = {
    submit: { mutation: submitMutation, fallback: "Failed to save policy rule." },
    delete: { mutation: deleteMutation, fallback: "Failed to delete policy rule." },
    reorder: { mutation: reorderMutation, fallback: "Failed to reorder policy rules." }
  };
  const [lastAction, setLastAction] = useState<keyof typeof actions | null>(null);
  const last = lastAction ? actions[lastAction] : null;
  // Select by status, not by the error value: a rejection with a falsy value
  // ("" or 0) is still a failure and shows the fallback.
  let error: string | null = null;
  if (last?.mutation.isError) error = toErrorMessage(last.mutation.error, last.fallback);
  else if (rulesQuery.isError) error = toErrorMessage(rulesQuery.error, "Failed to load Policy Center.");

  let busyKey: string | null = null;
  if (submitMutation.isPending) busyKey = "submit";
  else if (reorderMutation.isPending) busyKey = "reorder";
  else if (deleteMutation.isPending && deleteMutation.variables) {
    busyKey = `delete-${deleteMutation.variables}`;
  }

  return {
    rules: (rulesQuery.data ?? []) as PolicyRule[],
    lintWarnings: (lintQuery.data ?? []) as PolicyLintWarning[],
    loading: rulesQuery.isLoading,
    busyKey,
    error,
    simulation: simulateMutation.data ?? null,
    simulating: simulateMutation.isPending,
    saveRule: async (ruleId: string | null, input: PolicyRuleInput): Promise<boolean> => {
      setLastAction("submit");
      try {
        await submitMutation.mutateAsync({ ruleId, input });
        return true;
      } catch {
        return false;
      }
    },
    deleteRule: (ruleId: string) => {
      setLastAction("delete");
      deleteMutation.mutate(ruleId);
    },
    reorderRules: (ruleIds: string[]) => {
      setLastAction("reorder");
      reorderMutation.mutate(ruleIds);
    },
    runSimulation: (input: PolicySimulateRequest) => simulateMutation.mutate(input)
  };
}

export type { DecisionFilters } from "../components/admin/policy/admin-policy-decision-url";

/** Monitor evidence for the last seven days, grouped by rule. */
export function usePolicyMonitorSummary(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.admin.policyMonitorSummary(),
    queryFn: getPolicyMonitorSummary,
    enabled: options.enabled ?? true
  });
}

function toApiFilters(filters: DecisionFilters): PolicyDecisionsListParams {
  return {
    matchedRuleId: filters.matchedRuleId,
    evidence: filters.evidence,
    outcomes: filters.outcomes,
    enforced: filters.enforced,
    toolNames: filters.toolNames,
    severities: filters.severities,
    // parseDecisionUrl allows only one of since/from.
    from: filters.since ?? filters.from,
    to: filters.to
  };
}

/**
 * Decisions evidence log. The filters live in the URL (see
 * admin-policy-decision-url.ts); page state is local. Offset paging needs a
 * fixed upper bound: the exact window end when the URL has one, otherwise the
 * newest row of page 0, pinned again when filters change or on Refresh.
 */
export function useDecisionsData() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const parsed = useMemo(() => parseDecisionUrl(new URLSearchParams(search)), [search]);
  const filters = useMemo(() => (parsed.ok ? parsed.filters : {}), [parsed]);
  const filtersKey = decisionFiltersKey(filters);
  const [pageState, setPageState] = useState({ filtersKey, page: 0 });
  // A new filter set (Apply, a link, back/forward) starts at page 1.
  const page = pageState.filtersKey === filtersKey ? pageState.page : 0;
  const setPage = (update: (current: number) => number) =>
    setPageState({ filtersKey, page: update(page) });
  // Bumped on Refresh to force a fresh page-0 snapshot (and thus a new `before`).
  const [snapshotNonce, setSnapshotNonce] = useState(0);

  const limit = POLICY_DECISIONS_PAGE_SIZE;
  const offset = page * limit;
  const baseParams = useMemo(() => toApiFilters(filters), [filters]);

  // Page 0 and later pages share one cache key shape, so a later page can find
  // the page-0 result of the same filter set and snapshot. `filtersKey` lets
  // placeholderData tell filter sets apart; `snapshotNonce` makes Refresh a new
  // entry without changing what is sent to the server.
  const cacheKey = (params: PolicyDecisionsListParams) =>
    queryKeys.admin.policyDecisions({ ...params, filtersKey, snapshotNonce });

  // An exact window end (`until`) bounds every page. Without one, pages > 0
  // pin to the top timestamp of THIS page-0 result, so the list does not drift
  // as new decisions arrive between loads. Derive it from the cached page 0
  // rather than state written in the fetch: a new filter set has its own key,
  // which stays empty until its own page 0 loads.
  const page0Cached =
    page > 0 && !filters.until
      ? queryClient.getQueryData<PolicyDecisionsListResponse>(cacheKey({ ...baseParams, limit, offset: 0 }))
      : undefined;
  const before = filters.until ?? page0Cached?.decisions[0]?.createdAt;

  const apiParams: PolicyDecisionsListParams = useMemo(
    () => ({ ...baseParams, before, limit, offset }),
    [baseParams, before, limit, offset]
  );
  const queryKey = cacheKey(apiParams);

  const decisionsQuery = useQuery({
    queryKey,
    queryFn: () => listPolicyDecisions(apiParams),
    // A URL that cannot be read shows the problem, not rows for a wider scope.
    enabled: parsed.ok,
    // Keep the previous page on screen while the next page of the SAME filters
    // loads. Rows from another filter set are never shown under the new one.
    placeholderData: (previous, previousQuery) => {
      const previousParams = previousQuery?.queryKey.at(-1) as { filtersKey?: string } | undefined;
      return previousParams?.filtersKey === filtersKey ? previous : undefined;
    }
  });

  const applyFilters = (next: DecisionFilters) => {
    const params = writeDecisionUrl(new URLSearchParams(search), next).toString();
    setPageState({ filtersKey: decisionFiltersKey(next), page: 0 });
    router.replace(params ? `${pathname}?${params}` : pathname, { scroll: false });
  };

  const refresh = () => {
    setPageState({ filtersKey, page: 0 });
    setSnapshotNonce((n) => n + 1);
  };

  const data = parsed.ok ? decisionsQuery.data : undefined;
  const total = data?.total ?? 0;
  const pageCount = total === 0 ? 0 : Math.ceil(total / limit);

  return {
    decisions: data?.decisions ?? [],
    total,
    hasMore: data?.hasMore ?? false,
    page,
    pageCount,
    limit,
    offset,
    loading: parsed.ok && decisionsQuery.isLoading,
    fetching: decisionsQuery.isFetching,
    error: decisionsQuery.error ? toErrorMessage(decisionsQuery.error, "Failed to load decisions.") : null,
    filters,
    urlProblems: parsed.ok ? [] : parsed.problems,
    applyFilters,
    nextPage: () => setPage((p) => (data?.hasMore ? p + 1 : p)),
    prevPage: () => setPage((p) => Math.max(0, p - 1)),
    refresh
  };
}

/** Lazily loads a single decision's full detail (incl. action snapshot). */
export function useDecisionDetail(decisionId: string | null) {
  const detailQuery = useQuery({
    queryKey: decisionId ? queryKeys.admin.policyDecision(decisionId) : ["admin", "policy", "decision", "none"],
    queryFn: () => getPolicyDecision(decisionId as string),
    enabled: decisionId !== null
  });
  return {
    detail: detailQuery.data ?? null,
    loading: detailQuery.isLoading && decisionId !== null,
    error: detailQuery.error ? toErrorMessage(detailQuery.error, "Failed to load decision detail.") : null
  };
}
