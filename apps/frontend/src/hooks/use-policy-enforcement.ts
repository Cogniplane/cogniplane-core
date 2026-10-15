"use client";

import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import type { PolicyMonitorSummaryResponse, TenantSettings } from "@cogniplane/shared-types";

import { getPolicyMonitorSummary, getTenantSettings } from "../lib/admin-api";
import { toErrorMessage } from "../lib/error-utils";
import { queryKeys } from "../lib/query-keys";
import { usePolicyMonitorSummary } from "./use-policy-data";
import { useTenantSettings } from "./use-tenant-settings";

/** The evidence and settings version that the administrator reviews. */
export type EnforcementReviewSnapshot = {
  summary: PolicyMonitorSummaryResponse;
  settingsVersion: number;
  readAt: string;
};

export type SaveFailure = {
  // conflict: the server answered 409. unconfirmed: any other failure, which
  // can happen after the change was saved.
  kind: "conflict" | "unconfirmed";
  message: string;
};

export type EnforcementReview =
  | { phase: "closed" }
  | { phase: "reading" }
  | { phase: "readFailed"; message: string }
  | { phase: "ready"; snapshot: EnforcementReviewSnapshot; failure: SaveFailure | null };

export type ModeNotice = { tone: "done" | "problem"; text: string };

/**
 * Monitor → Enforce goes through one review. Opening the review reads the
 * evidence and the settings again, and the save sends the settings version
 * that the review showed. A failed save reloads the settings before anything
 * can be sent again, because the change can be saved even when the response
 * fails. Enforce → Monitor is one action with the same save handling.
 */
export function usePolicyEnforcement() {
  const queryClient = useQueryClient();
  const tenantSettings = useTenantSettings();
  const { settings } = tenantSettings;
  const monitoring = settings?.policyEnforcementMode === "monitor";
  const summary = usePolicyMonitorSummary({ enabled: monitoring });

  const [review, setReview] = useState<EnforcementReview>({ phase: "closed" });
  const [reloading, setReloading] = useState(false);
  const [reloadFailed, setReloadFailed] = useState(false);
  const [notice, setNotice] = useState<ModeNotice | null>(null);
  // Each read gets a number. A read that finishes after a newer one started,
  // or after the review closed, is dropped.
  const readRef = useRef(0);
  const busyRef = useRef(false);

  const fetchSettings = () =>
    queryClient.fetchQuery<TenantSettings>({
      queryKey: queryKeys.admin.tenantSettings(),
      queryFn: getTenantSettings,
      staleTime: 0
    });

  const fetchSummary = () =>
    queryClient.fetchQuery<PolicyMonitorSummaryResponse>({
      queryKey: queryKeys.admin.policyMonitorSummary(),
      queryFn: getPolicyMonitorSummary,
      staleTime: 0
    });

  async function reloadSettings(): Promise<TenantSettings | null> {
    setReloading(true);
    try {
      const fresh = await fetchSettings();
      setReloadFailed(false);
      return fresh;
    } catch {
      setReloadFailed(true);
      return null;
    } finally {
      setReloading(false);
    }
  }

  async function openReview(): Promise<void> {
    const read = ++readRef.current;
    tenantSettings.resetSaveError();
    setNotice(null);
    setReloadFailed(false);
    setReview({ phase: "reading" });
    try {
      const [freshSettings, freshSummary] = await Promise.all([fetchSettings(), fetchSummary()]);
      if (read !== readRef.current) return;
      setReview({
        phase: "ready",
        snapshot: {
          summary: freshSummary,
          settingsVersion: freshSettings.version,
          readAt: new Date().toISOString()
        },
        failure: null
      });
    } catch (error) {
      if (read !== readRef.current) return;
      setReview({ phase: "readFailed", message: toErrorMessage(error, "Could not read the evidence.") });
    }
  }

  const enforceOnText =
    "Enforce is on. It applies from the next turn of each session. Turns already running keep their current mode.";

  function closeReview(): void {
    readRef.current += 1;
    // A save whose response failed can still have turned Enforce on.
    if (review.phase !== "closed" && settings?.policyEnforcementMode === "enforce") {
      setNotice({ tone: "done", text: enforceOnText });
    }
    setReview({ phase: "closed" });
  }

  function failureFrom(status: number | null, fallback: string): SaveFailure {
    return status === 409
      ? { kind: "conflict", message: "Organization settings changed after this review opened." }
      : { kind: "unconfirmed", message: fallback };
  }

  /** Returns true when the save is confirmed. */
  async function enable(): Promise<boolean> {
    if (busyRef.current || review.phase !== "ready") return false;
    const { snapshot } = review;
    if (!settings || settings.version !== snapshot.settingsVersion || settings.policyEnforcementMode !== "monitor") {
      return false;
    }
    busyRef.current = true;
    tenantSettings.resetSaveError();
    try {
      const result = await tenantSettings.saveWithResult({
        expectedVersion: snapshot.settingsVersion,
        policyEnforcementMode: "enforce"
      });
      if (result.ok) {
        readRef.current += 1;
        setReview({ phase: "closed" });
        setNotice({ tone: "done", text: enforceOnText });
        return true;
      }
      const failure = failureFrom(
        result.status,
        "The server did not confirm the save. Enforcement can be on even when this error shows."
      );
      setReview({ phase: "ready", snapshot, failure });
      await reloadSettings();
      return false;
    } finally {
      busyRef.current = false;
    }
  }

  /**
   * After an unconfirmed save or a failed settings read, the page does not know
   * the current mode or version. A new save waits for a successful reload.
   */
  const settingsUncertain = reloadFailed || tenantSettings.loadError !== null;

  async function switchToMonitor(): Promise<void> {
    if (busyRef.current || settingsUncertain || !settings || settings.policyEnforcementMode !== "enforce") return;
    busyRef.current = true;
    tenantSettings.resetSaveError();
    setNotice(null);
    try {
      const result = await tenantSettings.saveWithResult({
        expectedVersion: settings.version,
        policyEnforcementMode: "monitor"
      });
      if (result.ok) {
        setNotice({
          tone: "done",
          text:
            "Monitor is on. Rules stop blocking tool calls from the next turn of each session. Turns already running keep their current mode."
        });
        return;
      }
      const failure = failureFrom(result.status, "");
      const fresh = await reloadSettings();
      setNotice({
        tone: "problem",
        text:
          fresh === null
            ? "The server did not confirm the switch to Monitor. The change can be saved even when this error shows."
            : failure.kind === "conflict"
              ? `Organization settings changed before the switch. The page now shows the current mode (${fresh.policyEnforcementMode === "enforce" ? "Enforce" : "Monitor"}).`
              : `The server did not confirm the switch. The page loaded the current settings again: the mode is ${fresh.policyEnforcementMode === "enforce" ? "Enforce" : "Monitor"}.`
      });
    } finally {
      busyRef.current = false;
    }
  }

  return {
    settings,
    loadError: tenantSettings.loadError,
    saving: tenantSettings.saving,
    summary,
    review,
    reloading,
    reloadFailed,
    settingsUncertain,
    notice,
    clearNotice: () => setNotice(null),
    openReview,
    closeReview,
    enable,
    switchToMonitor,
    reloadSettings: async () => {
      await reloadSettings();
    }
  };
}
