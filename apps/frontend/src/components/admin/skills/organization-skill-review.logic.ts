export type DiffLine = { kind: "same" | "remove" | "add"; text: string };

/**
 * Line diff by longest common subsequence. Above 160,000 line pairs the table
 * gets too large, so the diff shows every old line removed and every new line
 * added.
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const before = oldText.split("\n"), after = newText.split("\n");
  if (before.length * after.length > 160000) return [
    ...before.map((text) => ({ kind: "remove" as const, text })),
    ...after.map((text) => ({ kind: "add" as const, text }))
  ];
  const dp: number[][] = Array.from({ length: before.length + 1 }, () => Array(after.length + 1).fill(0));
  for (let i = before.length - 1; i >= 0; i--) for (let j = after.length - 1; j >= 0; j--)
    dp[i][j] = before[i] === after[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const lines: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) { lines.push({ kind: "same", text: before[i++] }); j++; }
    else if (i < before.length && (j === after.length || dp[i + 1][j] >= dp[i][j + 1])) lines.push({ kind: "remove", text: before[i++] });
    else lines.push({ kind: "add", text: after[j++] });
  }
  return lines;
}
