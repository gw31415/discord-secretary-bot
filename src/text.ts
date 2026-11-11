/** The text cut to `max` characters, with `marker` added where it was cut. */
export function truncate(text: string, max: number, marker = "…"): string {
  return text.length > max ? `${text.slice(0, max)}${marker}` : text;
}

/** A reason that follows another sentence ("…できませんでした。<reason>"), ending with "。" unless it ends with one or was cut. */
export function sentence(text: string): string {
  const trimmed = text.trimEnd();
  return !trimmed || /[。!?…]$/.test(trimmed) ? trimmed : `${trimmed}。`;
}
