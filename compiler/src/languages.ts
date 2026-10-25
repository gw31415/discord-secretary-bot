import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// A language is one directory under languages/: language.json says what it
// accepts and which toolchain and root filesystem it builds in, build.sh is
// the build that runs inside the sandbox, setup.sh (and prewarm.sh) make the
// toolchain, and sdk/ and template/ are copied next to the sources. The service itself knows nothing about any language,
// so adding one means adding a directory.

export const ABI = "secretary/1";

export interface Language {
  id: string;
  name: string;
  /** The language module's own version; with the files' hash it keys the cache. */
  version: string;
  /** What the person writes: one of these must be among the files. */
  entry: string[];
  extensions: string[];
  /** Paths a request may use, relative to the source root. */
  paths: RegExp;
  maxFiles: number;
  timeoutMs: number;
  env: Record<string, string>;
  abi: string[];
  /** Libraries the build can use without asking for them. */
  libraries: string[];
  /** Directory under the toolchains root, mounted at /toolchain. */
  toolchain: string;
  /** Directory under the rootfs root, mounted at /. */
  rootfs: string;
  /** Absolute path of languages/<id>. */
  dir: string;
  /** Hash of the directory but guide.md and tests/: a change to how it builds misses the cache. */
  fingerprint: string;
}

export class LanguageError extends Error {}

const ID = /^[a-z][a-z0-9-]{0,31}$/;
const DIR_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Reads every language directory under `root`; a broken one is reported and left out. */
export function loadLanguages(root: string, warn: (message: string) => void = () => {}): Map<string, Language> {
  const out = new Map<string, Language>();
  if (!existsSync(root)) return out;
  for (const name of readdirSync(root).sort()) {
    const dir = join(root, name);
    if (!statSync(dir).isDirectory()) continue;
    try {
      const language = loadLanguage(dir);
      if (language.id !== name) throw new LanguageError(`id "${language.id}" とディレクトリ名 "${name}" が違います`);
      out.set(language.id, language);
    } catch (e) {
      warn(`言語 ${name} を読めません: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

export function loadLanguage(dir: string): Language {
  const raw = JSON.parse(readFileSync(join(dir, "language.json"), "utf8")) as Record<string, unknown>;
  const str = (key: string): string => {
    const v = raw[key];
    if (typeof v !== "string" || !v) throw new LanguageError(`${key} がありません`);
    return v;
  };
  const strings = (key: string, fallback?: string[]): string[] => {
    const v = raw[key] ?? fallback;
    if (!Array.isArray(v) || !v.every((s) => typeof s === "string")) throw new LanguageError(`${key} は文字列の配列にしてください`);
    return v as string[];
  };
  const id = str("id");
  if (!ID.test(id)) throw new LanguageError(`id "${id}" は英小文字・数字・- にしてください`);
  const toolchain = str("toolchain");
  const rootfs = str("rootfs");
  for (const d of [toolchain, rootfs]) if (!DIR_NAME.test(d)) throw new LanguageError(`ディレクトリ名 "${d}" が不正です`);
  if (!existsSync(join(dir, "build.sh"))) throw new LanguageError("build.sh がありません");
  const env = (raw.env ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(env)) if (!/^[A-Z_][A-Z0-9_]*$/.test(k) || typeof v !== "string") throw new LanguageError(`env.${k} が不正です`);
  const entry = strings("entry");
  const paths = new RegExp(str("paths"));
  for (const e of entry) if (!paths.test(e)) throw new LanguageError(`entry "${e}" が paths に合いません`);
  return {
    id,
    name: str("name"),
    version: str("version"),
    entry,
    extensions: strings("extensions"),
    paths,
    maxFiles: typeof raw.maxFiles === "number" ? raw.maxFiles : 32,
    timeoutMs: typeof raw.timeoutMs === "number" ? raw.timeoutMs : 120_000,
    env: env as Record<string, string>,
    abi: strings("abi", [ABI]),
    libraries: strings("libraries", []),
    toolchain,
    rootfs,
    dir,
    fingerprint: fingerprint(dir),
  };
}

function fingerprint(dir: string): string {
  const hash = createHash("sha256");
  const walk = (path: string): void => {
    const s = statSync(path);
    if (s.isDirectory()) {
      for (const name of readdirSync(path).sort()) walk(join(path, name));
    } else {
      hash.update(relative(dir, path)).update("\0").update(readFileSync(path)).update("\0");
    }
  };
  for (const name of readdirSync(dir).sort()) if (name !== "guide.md" && name !== "tests") walk(join(dir, name));
  return hash.digest("hex").slice(0, 16);
}

/** Whether `setup` has made the toolchain and the root filesystem this language builds in. */
export function isReady(language: Language, toolchainsRoot: string, rootfsRoot: string): boolean {
  return existsSync(join(toolchainsRoot, language.toolchain, ".ready")) && existsSync(join(rootfsRoot, language.rootfs, ".ready"));
}

/** The guide for whoever writes the code (an AI, mostly). */
export function guide(language: Language): string {
  const path = join(language.dir, "guide.md");
  return existsSync(path) ? readFileSync(path, "utf8") : `${language.name} の書き方の案内はありません。`;
}

/** What /v1/languages says about a language. */
export function describe(language: Language, ready: boolean) {
  return {
    id: language.id,
    name: language.name,
    version: `${language.version}+${language.fingerprint.slice(0, 8)}`,
    entry: language.entry,
    extensions: language.extensions,
    paths: language.paths.source,
    maxFiles: language.maxFiles,
    timeoutMs: language.timeoutMs,
    abi: language.abi,
    libraries: language.libraries,
    ready,
  };
}
