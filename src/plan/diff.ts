// A line diff for the approval dialog: two versions of a rule's code, shown
// as hunks with a few lines of context so the reader sees what moved.

/** Lines beyond this on either side are not compared; the whole is in 「JSONを見る」. */
const MAX_LINES = 1500;

/** A unified-style diff ("+ " added, "- " removed, "  " kept) with `context` lines around each change; "" when equal. */
export function lineDiff(before: string, after: string, context = 2): string {
  if (before === after) return "";
  const a = before.split("\n").slice(0, MAX_LINES);
  const b = after.split("\n").slice(0, MAX_LINES);
  // Longest common subsequence, from the end, so the walk below goes forward.
  const lcs: Uint16Array[] = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  }
  const lines: Array<{ mark: " " | "+" | "-"; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push({ mark: " ", text: a[i]! });
      i++;
      j++;
    } else if (i < a.length && (j >= b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      lines.push({ mark: "-", text: a[i++]! });
    } else {
      lines.push({ mark: "+", text: b[j++]! });
    }
  }
  const near = lines.map((l, k) => lines.slice(Math.max(0, k - context), k + context + 1).some((n) => n.mark !== " "));
  const out: string[] = [];
  lines.forEach((l, k) => {
    if (near[k]) out.push(`${l.mark} ${l.text}`);
    else if (k > 0 && near[k - 1]) out.push("…");
  });
  return out.join("\n");
}
