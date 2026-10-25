import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Diagnostic, parseDiagnostics } from "./diagnostics.ts";
import { isReady, type Language } from "./languages.ts";
import type { CompileRequest } from "./request.ts";
import type { BoxRunner } from "./sandbox.ts";

// One compile: a fresh job directory with the sources under src/, the
// language's build.sh in a box, and out/module.wasm read back. The job
// directory is removed whatever happens. Builds wait their turn (one at a time
// by default: the host has two cores and a bot to keep running), and the same
// sources for the same language build come back from the cache.

export const MAX_MODULE_BYTES = 8 * 1024 * 1024;

export type CompileResult =
  | { ok: true; wasm: Buffer; sha256: string; log: string; durationMs: number; cached: boolean; language: string; version: string }
  | { ok: false; stage: "compile" | "link" | "limit"; diagnostics: Diagnostic[]; log: string; durationMs: number; cached: boolean; language: string; version: string };

export interface CompilerPaths {
  toolchains: string;
  rootfs: string;
  jobs: string;
}

export interface CompilerOptions {
  languages: Map<string, Language>;
  paths: CompilerPaths;
  box: BoxRunner;
  concurrency?: number;
  maxQueue?: number;
  cacheSize?: number;
}

export class Busy extends Error {}
export class NotReady extends Error {}
/** bubblewrap could not make the box; nothing about the source, so it is not cached. */
export class BoxFailed extends Error {}

export class Compiler {
  readonly languages: Map<string, Language>;
  readonly #paths: CompilerPaths;
  readonly #box: BoxRunner;
  readonly #concurrency: number;
  readonly #maxQueue: number;
  readonly #cacheSize: number;
  readonly #cache = new Map<string, CompileResult>();
  readonly #waiting: Array<() => void> = [];
  #running = 0;
  #compiled = 0;

  constructor(options: CompilerOptions) {
    this.languages = options.languages;
    this.#paths = options.paths;
    this.#box = options.box;
    this.#concurrency = options.concurrency ?? 1;
    this.#maxQueue = options.maxQueue ?? 8;
    this.#cacheSize = options.cacheSize ?? 64;
  }

  ready(language: Language): boolean {
    return isReady(language, this.#paths.toolchains, this.#paths.rootfs);
  }

  status() {
    return { running: this.#running, waiting: this.#waiting.length, compiled: this.#compiled, cached: this.#cache.size };
  }

  async compile(request: CompileRequest): Promise<CompileResult> {
    const { language } = request;
    if (!this.ready(language)) throw new NotReady(`${language.name} のツールチェーンがまだ用意されていません`);
    const key = cacheKey(request);
    const hit = this.#cache.get(key);
    if (hit) {
      this.#cache.delete(key);
      this.#cache.set(key, hit);
      return { ...hit, cached: true, durationMs: 0 };
    }
    await this.#slot();
    let result: CompileResult;
    try {
      result = await this.#build(request);
    } finally {
      this.#release();
    }
    this.#compiled++;
    // A run cut short by the limits may pass another time, so only finished builds are kept.
    if (result.ok || result.stage !== "limit") {
      this.#cache.set(key, result);
      while (this.#cache.size > this.#cacheSize) this.#cache.delete(this.#cache.keys().next().value!);
    }
    return result;
  }

  async #build(request: CompileRequest): Promise<CompileResult> {
    const { language } = request;
    const started = Date.now();
    const version = `${language.version}+${language.fingerprint.slice(0, 8)}`;
    await mkdir(this.#paths.jobs, { recursive: true });
    const work = await mkdtemp(join(this.#paths.jobs, "job-"));
    try {
      for (const file of request.files) {
        const path = join(work, "src", file.path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, file.content);
      }
      await mkdir(join(work, "out"));
      const outcome = await this.#box(
        {
          rootfs: join(this.#paths.rootfs, language.rootfs),
          toolchain: join(this.#paths.toolchains, language.toolchain),
          language: language.dir,
          work,
          env: { ...language.env, OPTIMIZE: request.optimize, ENTRY: request.files.find((f) => language.entry.includes(f.path))!.path },
          command: ["/bin/sh", "/lang/build.sh"],
        },
        language.timeoutMs,
      );
      const log = outcome.output;
      const durationMs = Date.now() - started;
      const base = { log, durationMs, cached: false, language: language.id, version };
      if (outcome.timedOut) return { ok: false, stage: "limit", diagnostics: [], ...base, log: `${log}\nコンパイルが${language.timeoutMs / 1000}秒を超えたので止めました`.trim() };
      // bubblewrap itself failed before the build began: the service is broken, not the source.
      if (outcome.exitCode !== 0 && /^bwrap: /.test(log)) throw new BoxFailed(`ビルド用の箱を作れませんでした(${log.split("\n")[0]!.slice(0, 200)})`);
      if (outcome.exitCode !== 0) {
        const diagnostics = parseDiagnostics(log);
        return { ok: false, stage: outcome.signal || /(No space left|File size limit|Killed)/i.test(log) ? "limit" : "compile", diagnostics, ...base };
      }
      const out = join(work, "out", "module.wasm");
      if (!existsSync(out)) return { ok: false, stage: "link", diagnostics: [], ...base, log: `${log}\nmodule.wasm ができませんでした`.trim() };
      if ((await stat(out)).size > MAX_MODULE_BYTES) return { ok: false, stage: "limit", diagnostics: [], ...base, log: `${log}\nできたモジュールが${MAX_MODULE_BYTES / 1024 / 1024}MBを超えています`.trim() };
      const wasm = await readFile(out);
      if (wasm.length < 8 || wasm.readUInt32BE(0) !== 0x0061736d) return { ok: false, stage: "link", diagnostics: [], ...base, log: `${log}\nできたファイルが Wasm ではありません`.trim() };
      return { ok: true, wasm, sha256: createHash("sha256").update(wasm).digest("hex"), ...base };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  #slot(): Promise<void> {
    if (this.#running < this.#concurrency) {
      this.#running++;
      return Promise.resolve();
    }
    if (this.#waiting.length >= this.#maxQueue) return Promise.reject(new Busy("コンパイルの順番待ちがいっぱいです。少し待ってからもう一度送ってください"));
    return new Promise((resolve) => this.#waiting.push(resolve));
  }

  #release(): void {
    const next = this.#waiting.shift();
    if (next) next();
    else this.#running--;
  }
}

export function cacheKey(request: CompileRequest): string {
  const files = [...request.files].sort((a, b) => (a.path < b.path ? -1 : 1)).map((f) => [f.path, f.content]);
  return createHash("sha256")
    .update(JSON.stringify([request.language.id, request.language.version, request.language.fingerprint, request.language.toolchain, request.abi, request.optimize, files]))
    .digest("hex");
}
