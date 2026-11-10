/** The text as a sentence: ends with "。" even when it was written without one. */
export function endSentence(text: string): string {
  return text.endsWith("。") ? text : `${text}。`;
}
