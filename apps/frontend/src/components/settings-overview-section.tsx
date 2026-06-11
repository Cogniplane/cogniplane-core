import type { OverviewStat } from "@cogniplane/shared-types";
import { SECTION_LABEL } from "../lib/ui-tokens";

const STAT_CARD =
  "rounded-lg border border-outline-variant bg-surface-container-lowest p-4 transition-colors hover:border-outline";

export function SettingsOverviewSection(input: {
  error: string | null;
  overviewStats: OverviewStat[];
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
