/** Joins loaded pages and drops rows that a later page repeats. */
export function uniquePageItems<T>(
  pages: Array<{ items: T[] }> | undefined,
  idOf: (item: T) => string,
): T[] {
  const seen = new Set<string>();
  const items: T[] = [];
  for (const page of pages ?? []) {
    for (const item of page.items) {
      const id = idOf(item);
      if (seen.has(id)) continue;
      seen.add(id);
      items.push(item);
    }
  }
  return items;
}
