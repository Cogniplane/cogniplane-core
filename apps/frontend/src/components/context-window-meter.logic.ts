// Formatters lifted from the retired message-list.logic when its timeline UI
// was deleted; the context meter is their only remaining consumer.
export function formatTokenCount(n: number): string {
  if (n < 1_000) return `${Math.round(n)}`;
  if (n < 10_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

export function formatCostUsd(costUsd: number): string {
  if (costUsd < 0.0001) return "<$0.0001";
  if (costUsd < 0.01) return `$${costUsd.toFixed(4)}`;
  return `$${costUsd.toFixed(3)}`;
}
