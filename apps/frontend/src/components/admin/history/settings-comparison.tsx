import type { AdminSettingsComparison } from "@cogniplane/shared-types";
import { historyTime } from "./history-presentation";

export function SettingsComparison({ comparison }: { comparison: AdminSettingsComparison }) {
  const changed = comparison.changes.filter((change) => change.status === "changed");
  const uncertain = comparison.changes.filter((change) => change.status === "unavailable");
  const ref = (side: "before" | "after") => {
    const snapshot = comparison[side];
    return <div className="min-w-0 rounded-md bg-surface-container-low p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-on-surface-variant">{side === "before" ? "Earlier record" : "Later record"}</p>
      <p className="mt-1 font-semibold">{snapshot.version === null ? "Unversioned settings" : `Version ${snapshot.version}`}</p>
      <p className="mt-1 text-xs text-on-surface-variant">{snapshot.actorName}<br /><time dateTime={snapshot.createdAt}>{historyTime(snapshot.createdAt)}</time></p>
    </div>;
  };
  const rows = (items: typeof changed) => <dl className="divide-y divide-outline-variant">{items.map((change) => <div key={change.field} className="py-4">
    <dt className="text-sm font-semibold">{change.label}</dt>
    <dd className="mt-2 grid gap-2 sm:grid-cols-2">
      <div className="min-w-0 border-l-2 border-outline pl-3"><span className="text-xs text-on-surface-variant">Before</span><p className="mt-1 text-sm wrap-anywhere">{change.before}</p></div>
      <div className="min-w-0 border-l-2 border-brand pl-3"><span className="text-xs text-on-surface-variant">After</span><p className="mt-1 text-sm wrap-anywhere">{change.after}</p></div>
    </dd>
  </div>)}</dl>;
  return <section aria-labelledby="comparison-heading" className="border-t border-outline-variant pt-5">
    <h3 id="comparison-heading" className="text-base font-semibold">{changed.length === 1 ? "1 setting changed" : `${changed.length} settings changed`}</h3>
    <p className="mt-1 text-sm text-on-surface-variant">Comparing recorded snapshots. These may have version gaps and do not establish the current configuration.</p>
    <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">{ref("before")}{ref("after")}</div>
    {changed.length ? rows(changed) : <p className="py-4 text-sm text-on-surface-variant">No differences in the fields that can be compared.</p>}
    <p className="text-xs text-on-surface-variant">{comparison.unchangedCount} settings unchanged. Instruction contents and unreviewed legacy fields are not shown.</p>
    {uncertain.length ? <details className="mt-4 rounded-lg border border-outline-variant p-3">
      <summary className="cursor-pointer text-sm font-medium">{uncertain.length} {uncertain.length === 1 ? "setting" : "settings"} cannot be compared completely</summary>
      <p className="mt-2 text-sm text-on-surface-variant">A value was missing, redacted, or used an unsupported format. Missing values are not treated as defaults.</p>
      {rows(uncertain)}
    </details> : null}
  </section>;
}
