import { DataRouteControl } from "../services/data-route-control.js";

/**
 * The data-route checks of dev-headers mode: no step-up and no owner notice.
 * For route tests that do not test those checks (routes/step-up-routes.test.ts
 * and services/data-route-control.test.ts do).
 */
export function devDataRoutes(): DataRouteControl {
  return new DataRouteControl({ authMode: "dev-headers", ownerNotices: null });
}

/**
 * Options of a store write in tests that do not test the step-up
 * classification (services/policy/policy-weakening.ts and
 * services/pii/pii-weakening.ts). They allow every change, as after step-up.
 */
export const ALLOW_WEAKER = { allowWeaker: true } as const;

/** The same for a PII save: no classification, every change allowed. */
export const PII_SAVE_ALLOWED = { weakerFields: (): string[] => [], allowWeaker: true } as const;
