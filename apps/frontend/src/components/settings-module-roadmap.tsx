const SECTION_LABEL =
  "text-[0.62rem] font-bold uppercase tracking-[0.14em] text-on-surface-faint";
const PILL_GREEN =
  "inline-flex items-center rounded-full bg-success-surface px-2 py-0.5 text-xs font-medium text-success";
const MODULE_CARD =
  "flex flex-col gap-2 rounded-lg border border-outline-variant bg-surface-container-lowest p-4";

export function SettingsModuleRoadmap(input: { scheduledJobCount: number }) {
  const { scheduledJobCount } = input;

  return (
    <section className="flex flex-col gap-4">
      <div>
        <p className={SECTION_LABEL}>Settings modules</p>
        <h3 className="text-lg font-semibold text-on-surface">Available settings</h3>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <article className={MODULE_CARD}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className={PILL_GREEN}>Live</span>
            <span className="text-xs text-on-surface-faint tabular-nums">
              {scheduledJobCount} jobs
            </span>
          </div>
          <h4 className="text-base font-semibold text-on-surface">Scheduled jobs</h4>
          <p className="text-sm text-on-surface-variant">
            Cron-style recurring work with per-user ownership, defaults, and next-run visibility.
          </p>
        </article>
      </div>
    </section>
  );
}
