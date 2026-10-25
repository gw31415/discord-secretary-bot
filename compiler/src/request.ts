import { ABI, type Language } from "./languages.ts";

// What a compile request may carry: source files only, at paths the language
// allows. Build settings (Cargo.toml, go.mod, flags) come from the language
// directory, so nothing in a request decides what runs while it builds.

export const MAX_SOURCE_BYTES = 256 * 1024;

export interface SourceFile {
  path: string;
  content: string;
}

export interface CompileRequest {
  language: Language;
  files: SourceFile[];
  abi: string;
  optimize: "size" | "speed";
}

export class RequestError extends Error {}

export function parseCompileRequest(body: unknown, languages: Map<string, Language>): CompileRequest {
  if (!body || typeof body !== "object") throw new RequestError("JSON のオブジェクトを送ってください");
  const b = body as Record<string, unknown>;
  if (typeof b.language !== "string") throw new RequestError("language がありません");
  const language = languages.get(b.language);
  if (!language) throw new RequestError(`言語 ${b.language} はありません(使えるもの: ${[...languages.keys()].join(", ")})`);
  const abi = b.abi === undefined ? ABI : b.abi;
  if (typeof abi !== "string" || !language.abi.includes(abi)) throw new RequestError(`abi ${String(abi)} には対応していません(${language.abi.join(", ")})`);
  const optimize = b.optimize === undefined ? "size" : b.optimize;
  if (optimize !== "size" && optimize !== "speed") throw new RequestError('optimize は "size" か "speed" にしてください');
  if (!Array.isArray(b.files) || b.files.length === 0) throw new RequestError("files がありません");
  if (b.files.length > language.maxFiles) throw new RequestError(`ファイルは${language.maxFiles}個までです`);
  const seen = new Set<string>();
  let total = 0;
  const files: SourceFile[] = [];
  for (const f of b.files as unknown[]) {
    const file = f as Record<string, unknown> | null;
    if (!file || typeof file.path !== "string" || typeof file.content !== "string") throw new RequestError("files の各要素は { path, content } にしてください");
    const path = file.path;
    if (!safePath(path) || !language.paths.test(path)) throw new RequestError(`${path} は置けません(${language.name} で置けるのは ${language.paths.source} に合うパスです)`);
    if (seen.has(path)) throw new RequestError(`${path} が二度あります`);
    seen.add(path);
    total += Buffer.byteLength(file.content);
    if (total > MAX_SOURCE_BYTES) throw new RequestError(`ソースは合計${MAX_SOURCE_BYTES / 1024}KBまでです`);
    files.push({ path, content: file.content });
  }
  if (!language.entry.some((e) => seen.has(e))) throw new RequestError(`${language.entry.join(" か ")} が要ります`);
  return { language, files, abi, optimize };
}

/** Relative, no "." or ".." segments, no hidden files, nothing a shell or a path join could read differently. */
export function safePath(path: string): boolean {
  if (path.length === 0 || path.length > 200 || path.startsWith("/")) return false;
  return path.split("/").every((s) => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(s) && s !== "." && s !== "..");
}
