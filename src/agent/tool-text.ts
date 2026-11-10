import { truncate } from "../text.ts";

/** Where a tool's output was cut; the model sees it was cut. */
export const TOOL_CUT = "\n…(長いため省略)";

/** A tool result holding text, cut to `max` characters. */
export function toolText(value: string, max: number) {
  return { content: [{ type: "text" as const, text: truncate(value, max, TOOL_CUT) }], details: {} };
}
