"use client";

import { useEffect, useMemo, useState } from "react";

import { useAdminSkillJudgeData } from "../../../hooks/use-admin-skill-judge-data";
import type {
  SkillJudgeMode,
  SkillJudgeProviderId,
  SkillJudgeSettings
} from "../../../lib/admin-api";
import { describeLogEntry, formatInterval, logTone } from "./page.logic";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";

const SECTION_LABEL =
  "text-[0.62rem] font-bold uppercase tracking-[0.14em] text-on-surface-faint";
const HINT = "text-sm text-on-surface-variant";
const STAT_CARD =
  "rounded-xl border border-outline-variant bg-surface-container-low px-4 py-3";

const TONE_TEXT: Record<"ok" | "warn" | "err", string> = {
  ok: "text-on-surface",
  warn: "text-warning",
  err: "text-danger"
};

export default function AdminSkillJudgePage() {
  const {
    data,
    isLoading,
    loadError,
    saving,
    saveError,
    savedAt,
    save,
    running,
    runLog,
    runNow
  } = useAdminSkillJudgeData();

  const [enabled, setEnabled] = useState(false);
  const [provider, setProvider] = useState<SkillJudgeProviderId | "">("");
  const [model, setModel] = useState<string>("");
  const [mode, setMode] = useState<SkillJudgeMode>("sync");

  useEffect(() => {
    if (!data) return;
    // Seed form draft from server-fetched settings on first load. A key-based
    // reset would require lifting state to the parent.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEnabled(data.settings.skillJudgeEnabled);
    setProvider(data.settings.skillJudgeProvider ?? "");
    setModel(
      data.settings.skillJudgeModel ??
        data.availableModels.find((m) => m.isDefault)?.id ??
        ""
    );
    setMode(data.settings.skillJudgeMode);
  }, [data]);

  const modelsForProvider = useMemo(() => {
    if (!data || !provider) return [];
    return data.availableModels.filter((m) => m.provider === provider);
  }, [data, provider]);

  const selectedModel = useMemo(
    () => data?.availableModels.find((m) => m.id === model) ?? null,
    [data, model]
  );

  const onChangeProvider = (next: SkillJudgeProviderId | "") => {
    setProvider(next);
    if (!next || !data) {
      setModel("");
      return;
    }
    const candidates = data.availableModels.filter((m) => m.provider === next);
    const fallback = candidates.find((m) => m.isDefault) ?? candidates[0];
    setModel(fallback?.id ?? "");
  };

  const onSave = async () => {
    const settings: SkillJudgeSettings = {
      skillJudgeEnabled: enabled,
      skillJudgeProvider: provider || null,
      skillJudgeModel: model || null,
      skillJudgeMode: mode
    };
    await save(settings);
  };

  const canSave = !saving && (!enabled || (Boolean(provider) && Boolean(model)));
  const canRun =
    !running &&
    Boolean(data?.platform.workerEnabled) &&
    enabled &&
    Boolean(provider) &&
    Boolean(model);

  const runDisabledReason = !data?.platform.workerEnabled
    ? "Worker is disabled at the platform level."
    : !enabled
      ? "Enable the judge for this tenant first."
      : undefined;

  return (
    <section className="space-y-6" id="skill-judge">
      <div>
        <p className={SECTION_LABEL}>Telemetry</p>
        <h3 className="text-lg font-bold text-on-surface">Skill judge</h3>
      </div>

      <Card>
        <CardHeader>
          <p className={SECTION_LABEL}>What this does</p>
          <h2 className="text-base font-semibold text-on-surface">
            An LLM checks which skills the agent actually used
          </h2>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-on-surface-variant">
          <p>
            After a session goes idle for a while, a small LLM reads the transcript and
            decides — for each skill that was available — whether the agent really
            followed it. The verdicts feed the &quot;skills used&quot; signal that the
            &quot;Improve with AI&quot; flow uses to assemble its corpus, and they power
            adoption dashboards.
          </p>
          <p>
            <strong className="font-semibold text-on-surface">
              Why a small model is preferred:
            </strong>{" "}
            the judge runs once per session, across hundreds or thousands of sessions
            per tenant, and answers a constrained classification question. A
            Haiku-class model is plenty for that — flagship models cost ~10× more
            without measurably better precision on this task. Start with the smallest
            option and only upgrade if you see consistent misclassifications.
          </p>
        </CardContent>
      </Card>

      {isLoading ? <p className="text-sm text-on-surface-variant">Loading…</p> : null}
      {loadError ? <p className="text-sm text-danger">{loadError}</p> : null}

      {data ? (
        <Card>
          <CardHeader className="space-y-2">
            <div>
              <p className={SECTION_LABEL}>Configuration</p>
              <h2 className="text-base font-semibold text-on-surface">Judge settings</h2>
            </div>
            <p className={HINT}>
              Platform interval: every {formatInterval(data.platform.pollIntervalMs)}.
              Sessions become eligible after {formatInterval(data.platform.inactiveBeforeMs)} of
              inactivity. Up to {data.platform.maxSessionsPerTick} sessions per tick.
            </p>
            {!data.platform.workerEnabled ? (
              <p className="text-sm text-danger">
                The platform-level worker is currently disabled
                (<code className="font-mono text-xs">SKILL_JUDGE_WORKER_ENABLED=false</code>).
                Save your settings — judging will start on the next deploy that enables
                the flag.
              </p>
            ) : null}
          </CardHeader>
          <CardContent className="space-y-5">
            <label className="flex items-start gap-3 rounded-lg border border-outline-variant bg-surface-container-lowest px-4 py-3">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
                className="mt-1 size-4 cursor-pointer accent-primary"
              />
              <div className="space-y-0.5">
                <strong className="block text-sm font-semibold text-on-surface">
                  Enabled for this tenant
                </strong>
                <small className="block text-xs text-on-surface-variant">
                  When on, the worker judges this tenant&apos;s inactive sessions on
                  each tick.
                </small>
              </div>
            </label>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="judge-provider">Provider</Label>
                <Select
                  value={provider || "none"}
                  onValueChange={(value) =>
                    onChangeProvider(value === "none" ? "" : (value as SkillJudgeProviderId))
                  }
                >
                  <SelectTrigger id="judge-provider" className="w-full">
                    <SelectValue placeholder="— select —" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">— select —</SelectItem>
                    <SelectItem value="anthropic">Anthropic</SelectItem>
                    <SelectItem value="openai">OpenAI</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="judge-model">Model</Label>
                <Select
                  value={model || "none"}
                  onValueChange={(value) => setModel(value === "none" ? "" : value)}
                  disabled={!provider}
                >
                  <SelectTrigger id="judge-model" className="w-full">
                    <SelectValue placeholder="— select —" />
                  </SelectTrigger>
                  <SelectContent>
                    {modelsForProvider.length === 0 ? (
                      <SelectItem value="none">— select —</SelectItem>
                    ) : null}
                    {modelsForProvider.map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        {option.label}
                        {option.isDefault ? " — recommended" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedModel?.hint ? (
                  <p className="text-xs text-on-surface-faint">{selectedModel.hint}</p>
                ) : null}
              </div>

              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label htmlFor="judge-mode">Mode</Label>
                <Select
                  value={mode}
                  onValueChange={(value) => setMode(value as SkillJudgeMode)}
                >
                  <SelectTrigger id="judge-mode" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sync">
                      Realtime (sync) — finishes within seconds
                    </SelectItem>
                    <SelectItem value="batch">
                      Batch — cheaper, can take up to 24h to resolve
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" onClick={onSave} disabled={!canSave}>
                {saving ? "Saving…" : "Save settings"}
              </Button>
              {savedAt ? (
                <span className="text-sm text-on-surface-variant">Saved.</span>
              ) : null}
              {saveError ? <span className="text-sm text-danger">{saveError}</span> : null}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {data ? (
        <Card>
          <CardHeader>
            <p className={SECTION_LABEL}>Status</p>
            <h2 className="text-base font-semibold text-on-surface">Queue health</h2>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <article className={STAT_CARD}>
                <p className={SECTION_LABEL}>Eligible right now</p>
                <strong className="mt-1 block text-2xl font-semibold text-on-surface">
                  {data.stats.eligibleNow}
                </strong>
                <p className={`mt-1 ${HINT}`}>
                  Sessions ready to be judged on the next tick.
                </p>
              </article>
              <article className={STAT_CARD}>
                <p className={SECTION_LABEL}>Sync in flight</p>
                <strong className="mt-1 block text-2xl font-semibold text-on-surface">
                  {data.stats.syncRunning}
                </strong>
                <p className={`mt-1 ${HINT}`}>
                  Mid-call sync requests. Should resolve in seconds; orphans from a
                  crash get reaped automatically on the next tick.
                </p>
              </article>
              <article className={STAT_CARD}>
                <p className={SECTION_LABEL}>Batches pending</p>
                <strong className="mt-1 block text-2xl font-semibold text-on-surface">
                  {data.stats.batchPending}
                </strong>
                <p className={`mt-1 ${HINT}`}>
                  {data.stats.oldestBatchSubmittedAt
                    ? `Oldest submitted ${new Date(data.stats.oldestBatchSubmittedAt).toLocaleString()}.`
                    : "Submitted to provider, awaiting result. Anthropic Batch can take up to 24h."}
                </p>
              </article>
              <article className={STAT_CARD}>
                <p className={SECTION_LABEL}>Recent failures</p>
                <strong className="mt-1 block text-2xl font-semibold text-on-surface">
                  {data.stats.recentFailures.length}
                </strong>
                <p className={`mt-1 ${HINT}`}>
                  Cleared by re-running or by clearing the row in SQL.
                </p>
              </article>
            </div>

            {data.stats.recentFailures.length > 0 ? (
              <div className="space-y-2 rounded-lg border border-outline-variant bg-surface-container-lowest p-3">
                <p className={SECTION_LABEL}>Recent failures</p>
                {data.stats.recentFailures.map((failure) => (
                  <div
                    key={failure.sessionId}
                    className="rounded-md border border-outline-variant/60 bg-surface-container-low px-3 py-2"
                  >
                    <code className="block font-mono text-xs text-on-surface">
                      {failure.sessionId}
                    </code>
                    <p className="mt-1 text-xs text-on-surface-variant">
                      {failure.error ?? "Unknown error."}
                    </p>
                  </div>
                ))}
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {data ? (
        <Card>
          <CardHeader className="space-y-2">
            <div>
              <p className={SECTION_LABEL}>Manual run</p>
              <h2 className="text-base font-semibold text-on-surface">Execute now</h2>
            </div>
            <p className={HINT}>
              Triggers a single tick of the judge worker for this tenant. Useful for
              debugging or after changing the model. The same per-session lock applies —
              already-judged sessions are skipped.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button
              type="button"
              onClick={runNow}
              disabled={!canRun}
              title={runDisabledReason}
            >
              {running ? "Running…" : "Execute now"}
            </Button>

            {runLog.length > 0 ? (
              <div className="space-y-1 rounded-lg border border-outline-variant bg-surface-container-lowest p-3">
                {runLog.map((entry, index) => {
                  const tone = logTone(entry);
                  return (
                    <div
                      key={index}
                      className="flex items-baseline gap-3 text-sm"
                    >
                      <span className="min-w-20 font-mono text-xs tabular-nums text-on-surface-faint">
                        {new Date(entry.at).toLocaleTimeString()}
                      </span>
                      <span className={TONE_TEXT[tone]}>{describeLogEntry(entry)}</span>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </section>
  );
}
