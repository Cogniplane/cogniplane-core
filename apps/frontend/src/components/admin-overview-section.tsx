import type { OverviewStat } from "@cogniplane/shared-types";

const SECTION_LABEL =
  "text-[0.62rem] font-bold uppercase tracking-[0.14em] text-on-surface-faint";
const STAT_CARD =
  "rounded-lg border border-outline-variant bg-surface-container-lowest p-4 transition-colors hover:border-outline";

export function AdminOverviewSection(input: {
  error: string | null;
  overviewStats: readonly OverviewStat[];
}) {
  const { error, overviewStats } = input;

  return (
    <>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <section
        id="overview"
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
      >
        {overviewStats.map((stat) => (
          <article className={STAT_CARD} key={stat.label}>
            <p className={SECTION_LABEL}>{stat.label}</p>
            <strong className="mt-2 block text-2xl font-bold tracking-tight text-on-surface tabular-nums">
              {stat.value}
            </strong>
            <p className="mt-1 text-xs text-on-surface-variant">{stat.detail}</p>
          </article>
        ))}
      </section>
    </>
  );
}
