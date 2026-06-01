"use client";

import { useMemo, useState } from "react";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

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
  createPolicyRule,
  deletePolicyRule,
  getPolicyDecision,
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
  // alongside the rules every time.
  const invalidateRules = () => {
    void queryClient.invalidateQueries({ queryKey: rulesKey });
    void queryClient.invalidateQueries({ queryKey: lintKey });
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

  const error =
    submitMutation.error || deleteMutation.error || reorderMutation.error || rulesQuery.error
      ? toErrorMessage(
          submitMutation.error ?? deleteMutation.error ?? reorderMutation.error ?? rulesQuery.error,
          "Failed to load Policy Center."
        )
      : null;

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
      try {
        await submitMutation.mutateAsync({ ruleId, input });
        return true;
      } catch {
        return false;
      }
    },
    deleteRule: (ruleId: string) => deleteMutation.mutate(ruleId),
    reorderRules: (ruleIds: string[]) => reorderMutation.mutate(ruleIds),
    runSimulation: (input: PolicySimulateRequest) => simulateMutation.mutate(input)
  };
}

// The filter set the decisions card controls (everything except paging, which the
// hook owns). Changing any of these resets back to page 1 and re-pins `before`.
export type DecisionFilters = Pick<
  PolicyDecisionsListParams,
  "outcomes" | "enforced" | "toolNames" | "severities" | "from" | "to"
>;

export const EMPTY_DECISION_FILTERS: DecisionFilters = {};

/**
 * Decisions evidence log: holds filter + page state and runs the filtered, paged
 * list query. `before` is pinned the first time a (filter) query loads and reused
 * across pages so offset paging doesn't drift as new decisions arrive; it's
 * cleared (and re-pinned) whenever filters change or the user refreshes.
 */
export function useDecisionsData() {
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<DecisionFilters>(EMPTY_DECISION_FILTERS);
  const [page, setPage] = useState(0);
  // Bumped on Refresh to force a fresh page-0 snapshot (and thus a new `before`).
  const [snapshotNonce, setSnapshotNonce] = useState(0);

  const limit = POLICY_DECISIONS_PAGE_SIZE;
  const offset = page * limit;

  // The API params for page 0 of the active filter set. It carries no `before`
  // (page 0 is always "newest first"); pages > 0 pin to the top timestamp of THIS
  // page-0 result so the window can't drift as new decisions arrive between loads.
  const page0Params: PolicyDecisionsListParams = useMemo(
    () => ({ ...filters, limit, offset: 0 }),
    [filters, limit]
  );
  // The cache key adds `snapshotNonce` so Refresh forces a distinct entry without
  // changing what's sent to the server.
  const page0Key = queryKeys.admin.policyDecisions({ ...page0Params, snapshotNonce });

  // Derive `before` from the already-cached page-0 data rather than writing it to
  // state from inside the fetch — that read can't race a filter change, because a
  // new filter set yields a different page0Key and its cache entry is empty until
  // its own page-0 load resolves.
  const page0Cached =
    page > 0 ? queryClient.getQueryData<PolicyDecisionsListResponse>(page0Key) : undefined;
  const before = page > 0 ? page0Cached?.decisions[0]?.createdAt : undefined;

  const apiParams: PolicyDecisionsListParams = useMemo(
    () => ({ ...filters, before, limit, offset }),
    [filters, before, limit, offset]
  );
  const queryKey = queryKeys.admin.policyDecisions({ ...apiParams, snapshotNonce });

  const decisionsQuery = useQuery({
    queryKey,
    queryFn: () => listPolicyDecisions(apiParams),
    placeholderData: keepPreviousData
  });

  const applyFilters = (next: DecisionFilters) => {
    setFilters(next);
    setPage(0);
  };

  const refresh = () => {
    setPage(0);
    setSnapshotNonce((n) => n + 1);
  };

  const data = decisionsQuery.data;
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
    loading: decisionsQuery.isLoading,
    fetching: decisionsQuery.isFetching,
    error: decisionsQuery.error ? toErrorMessage(decisionsQuery.error, "Failed to load decisions.") : null,
    filters,
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
