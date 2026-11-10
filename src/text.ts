/** The text cut to `max` characters, with `marker` added where it was cut. */
export function truncate(text: string, max: number, marker = "…"): string {
  return text.length > max ? `${text.slice(0, max)}${marker}` : text;
}
