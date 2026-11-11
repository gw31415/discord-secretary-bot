/**
 * The reply's outermost `{...}` (from the first "{" to the last "}"), parsed;
 * null when there is none or it is not valid JSON. Models often wrap their JSON
 * in prose or a code fence. Broken JSON is not repaired: it stays unreadable.
 */
export function firstJsonObject(text: string): Record<string, unknown> | null {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}
