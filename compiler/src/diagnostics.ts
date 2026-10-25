// Reads compiler messages in the "file:line:col: severity: message" shape that
// clang, rustc (--message-format=short) and go all print, so the caller can
// point at the line without reading the whole log. Go leaves out the severity;
// those are errors.

export interface Diagnostic {
  file: string;
  line: number;
  col: number;
  severity: "error" | "warning" | "note";
  message: string;
}

const MAX_DIAGNOSTICS = 50;
const LINE = /^(?:\.\/|\/work\/src\/)?([A-Za-z0-9_][\w./-]*\.[A-Za-z0-9]+):(\d+):(\d+):\s+(?:(fatal error|error|warning|note)(?:\[[\w-]+\])?:\s+)?(.+)$/;
// Terminal colours, in case a build prints them anyway.
const ANSI = /\x1b\[[0-9;]*m/g;

export function parseDiagnostics(log: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const raw of log.split("\n")) {
    const m = LINE.exec(raw.replace(ANSI, "").trimEnd());
    if (!m) continue;
    const severity = m[4] === "warning" ? "warning" : m[4] === "note" ? "note" : "error";
    out.push({ file: m[1]!, line: Number(m[2]), col: Number(m[3]), severity, message: m[5]!.slice(0, 500) });
    if (out.length >= MAX_DIAGNOSTICS) break;
  }
  return out;
}
