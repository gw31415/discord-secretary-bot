import type { Store, WasmModule, WasmSource } from "../db.ts";
import type { GuildState } from "../discord/permissions.ts";
import type { WasmRef } from "../plan/types.ts";
import { type CompileOutcome, type CompilerClient, CompilerUnavailable, type SourceFile } from "./compiler.ts";
import { type ModuleInfo, ModuleRejected, prepareModule } from "./module.ts";
import { warmUp } from "./run.ts";

// Uploaded Wasm modules: checks and keeps them, finds the one a rule names, and
// compiles each once. A module carries no permissions of its own; a rule that
// runs it acts with its owner's. So a rule may run a module someone else in the
// same server uploaded, and an older build stays as long as a rule runs it.

export const MAX_MODULES_PER_USER = 20;
export const MAX_BYTES_PER_USER = 50 * 1024 * 1024;
const NAME = /^[-_.\p{L}\p{N}]{1,40}$/u;
const COMPILED_CACHE = 16;
/** A module built from source stays this long before it must be kept (registered) or built again. */
export const FRESH_TTL_MS = 30 * 60 * 1000;
export const MAX_COMPILES_PER_HOUR = 30;

export { CompilerUnavailable, ModuleRejected };

/** A module the bot just built for someone, not kept yet. */
export interface FreshModule {
  ownerId: string;
  bytes: Buffer;
  info: ModuleInfo;
  source: WasmSource;
  expires: number;
}

export type CompileResult = { ok: true; module: FreshModule; log: string; durationMs: number; cached: boolean } | Extract<CompileOutcome, { ok: false }>;

export function wasmRef(module: WasmModule, source?: WasmSource): WasmRef {
  return { sha256: module.sha256, name: module.name, size: module.size, ownerId: module.ownerId, producers: module.info.producers, ...(source ? { source: { language: source.language, files: source.files } } : {}) };
}

export function sizeLabel(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

export class WasmRegistry {
  readonly #store: Store;
  // Kept for every build in use; a handful at most per person.
  readonly #compiled = new Map<string, Promise<WebAssembly.Module>>();
  readonly #compiler: CompilerClient | undefined;
  readonly #fresh = new Map<string, FreshModule>();
  readonly #compiling = new Set<string>();
  readonly #compiles = new Map<string, number[]>();

  constructor(store: Store, compiler?: CompilerClient) {
    this.#store = store;
    this.#compiler = compiler;
  }

  /** The compiler service, when one is configured. */
  get compiler(): CompilerClient | undefined {
    return this.#compiler;
  }

  /**
   * Builds a module from source with the compiler service, checks it like an
   * upload and holds it for FRESH_TTL_MS: run it, or keep it with uploadCompiled.
   * One build at a time per person, MAX_COMPILES_PER_HOUR an hour.
   */
  async compile(ownerId: string, language: string, files: SourceFile[], optimize: "size" | "speed" = "size"): Promise<CompileResult> {
    if (!this.#compiler) throw new CompilerUnavailable("コンパイラが用意されていません");
    if (this.#compiling.has(ownerId)) throw new ModuleRejected("前のコンパイルが終わってから送ってください");
    const now = Date.now();
    const recent = (this.#compiles.get(ownerId) ?? []).filter((t) => now - t < 60 * 60 * 1000);
    if (recent.length >= MAX_COMPILES_PER_HOUR) throw new ModuleRejected(`コンパイルは一人1時間に${MAX_COMPILES_PER_HOUR}回までです`);
    this.#compiling.add(ownerId);
    try {
      const outcome = await this.#compiler.compile(language, files, optimize);
      if (!outcome.cached) this.#compiles.set(ownerId, [...recent, now]);
      if (!outcome.ok) return outcome;
      const { bytes, info } = await prepareModule(outcome.wasm);
      const module: FreshModule = { ownerId, bytes, info, source: { language: outcome.language, version: outcome.version, files }, expires: Date.now() + FRESH_TTL_MS };
      this.#pruneFresh();
      this.#fresh.set(`${ownerId}:${info.sha256}`, module);
      return { ok: true, module, log: outcome.log, durationMs: outcome.durationMs, cached: outcome.cached };
    } finally {
      this.#compiling.delete(ownerId);
    }
  }

  /** A module the person built and has not kept, by sha256 (12+ hex characters). */
  fresh(ownerId: string, ref: string): FreshModule {
    this.#pruneFresh();
    const hex = ref.toLowerCase().replace(/^sha256:/, "");
    const found = /^[0-9a-f]{12,64}$/.test(hex) ? [...this.#fresh.entries()].filter(([k]) => k.startsWith(`${ownerId}:${hex}`)).map(([, m]) => m) : [];
    if (found.length === 1) return found[0]!;
    throw new ModuleRejected(found.length > 1 ? `${hex} に当てはまるモジュールが複数あります。もっと長く指定してください` : `コンパイルしたモジュール ${ref} がありません(${FRESH_TTL_MS / 60000}分で消えます。もう一度 compile_wasm してください)`);
  }

  /** Keeps a module the person built, with its sources. */
  async uploadCompiled(ownerId: string, name: string, ref: string): Promise<{ module: WasmModule; replaced: number }> {
    const fresh = this.fresh(ownerId, ref);
    return this.upload(ownerId, name, fresh.bytes, fresh.source);
  }

  /** The sources a build was compiled from, when the bot built it. */
  source(sha256: string): WasmSource | undefined {
    return this.#store.wasmSource(sha256);
  }

  #pruneFresh(): void {
    const now = Date.now();
    for (const [k, m] of this.#fresh) if (m.expires < now) this.#fresh.delete(k);
  }

  /**
   * Keeps a new upload under `name`. An earlier build with that name stays
   * while a rule runs it and is dropped otherwise.
   */
  async upload(ownerId: string, name: string, bytes: Uint8Array, source?: WasmSource): Promise<{ module: WasmModule; replaced: number }> {
    name = name.trim().replace(/\.wasm$/i, "");
    if (!NAME.test(name)) throw new ModuleRejected("名前は文字・数字・-・_・. の40文字までにしてください");
    const { bytes: kept, info } = await prepareModule(bytes);
    const mine = this.#store.listWasmModules(ownerId);
    const others = mine.filter((m) => m.sha256 !== info.sha256);
    const stale = others.filter((m) => m.name === name && this.#store.rulesUsingWasm(m.sha256).length === 0);
    const remaining = others.filter((m) => !stale.includes(m));
    if (remaining.length + 1 > MAX_MODULES_PER_USER) throw new ModuleRejected(`モジュールは一人${MAX_MODULES_PER_USER}個までです。使っていないものを消してください`);
    if (remaining.reduce((n, m) => n + m.size, 0) + kept.length > MAX_BYTES_PER_USER) throw new ModuleRejected(`モジュールは一人合計${MAX_BYTES_PER_USER / 1024 / 1024}MBまでです。使っていないものを消してください`);
    for (const m of stale) this.#store.deleteWasmModule(ownerId, m.sha256);
    const module = this.#store.saveWasmModule(ownerId, name, kept, info, source);
    void this.compiled(info.sha256).catch(() => undefined);
    this.#store.audit({ kind: "user", userId: ownerId, via: "panel" }, "wasm.upload", { name, sha256: info.sha256, size: kept.length, ...(source ? { language: source.language } : {}) });
    return { module, replaced: stale.length };
  }

  /** The person's modules: the newest build per name first, then older builds rules still run. */
  list(ownerId: string): WasmModule[] {
    return this.#store.listWasmModules(ownerId);
  }

  /** Whether `name` is the newest build of that name. */
  isLatest(module: WasmModule): boolean {
    return this.#store.listWasmModules(module.ownerId).find((m) => m.name === module.name)?.sha256 === module.sha256;
  }

  rulesUsing(sha256: string) {
    return this.#store.rulesUsingWasm(sha256);
  }

  /**
   * The module a rule names: the newest of the owner's own by name, or by
   * sha256 (12+ hex characters) one the owner or someone still in the server uploaded.
   */
  resolve(ownerId: string, guild: GuildState | null | undefined, ref: string): WasmModule {
    const mine = this.#store.listWasmModules(ownerId);
    const byName = mine.find((m) => m.name === ref);
    if (byName) return byName;
    const hex = ref.toLowerCase().replace(/^sha256:/, "");
    if (/^[0-9a-f]{12,64}$/.test(hex)) {
      const own = mine.filter((m) => m.sha256.startsWith(hex));
      if (own.length === 1) return own[0]!;
      const found = new Map<string, WasmModule>();
      for (const sha of this.#store.wasmShasWithPrefix(hex)) {
        const uploader = this.#store.wasmUploaders(sha).find((m) => m.ownerId === ownerId || guild?.members.has(m.ownerId));
        if (uploader) found.set(sha, uploader);
      }
      if (found.size === 1) return [...found.values()][0]!;
      if (found.size > 1) throw new ModuleRejected(`sha256 ${hex} に当てはまるモジュールが複数あります。もっと長く指定してください`);
    }
    throw new ModuleRejected(`Wasmモジュール「${ref}」が見つかりません。自分のモジュールの名前か、同じサーバーの人が上げたモジュールの sha256(12文字以上)を指定してください`);
  }

  /** Compiles once per build; the bytes were checked when they were uploaded. */
  compiled(sha256: string): Promise<WebAssembly.Module> {
    let module = this.#compiled.get(sha256);
    if (module) {
      this.#compiled.delete(sha256);
      this.#compiled.set(sha256, module);
      return module;
    }
    const bytes = this.#store.wasmBytes(sha256);
    if (!bytes) return Promise.reject(new Error(`Wasmモジュール ${sha256.slice(0, 12)} が消されています`));
    module = WebAssembly.compile(bytes);
    module.then((m) => void warmUp({ module: m }), () => this.#compiled.delete(sha256));
    this.#compiled.set(sha256, module);
    while (this.#compiled.size > Math.max(COMPILED_CACHE, this.#store.wasmInUse().length)) this.#compiled.delete(this.#compiled.keys().next().value!);
    return module;
  }

  /** Compiles the modules enabled rules run, ahead of their first event. */
  async precompileUsed(): Promise<number> {
    const shas = this.#store.wasmInUse();
    await Promise.all(shas.map((sha) => this.compiled(sha)));
    return shas.length;
  }

  rename(ownerId: string, sha256: string, name: string): void {
    name = name.trim().replace(/\.wasm$/i, "");
    if (!NAME.test(name)) throw new ModuleRejected("名前は文字・数字・-・_・. の40文字までにしてください");
    this.#store.renameWasmModule(ownerId, sha256, name);
  }

  /** Refused while a rule runs it. */
  remove(ownerId: string, sha256: string): WasmModule {
    const module = this.#store.getWasmModule(ownerId, sha256);
    if (!module) throw new ModuleRejected("そのモジュールはありません");
    // Another upload of the same bytes keeps them for the rules.
    const users = this.#store.wasmUploaders(sha256).length > 1 ? [] : this.#store.rulesUsingWasm(sha256);
    if (users.length) throw new ModuleRejected(`ルール「${users.map((r) => r.name).join("」「")}」が使っているので消せません。先にルールを消すか、別のモジュールに差し替えてください`);
    this.#store.deleteWasmModule(ownerId, sha256);
    this.#store.audit({ kind: "user", userId: ownerId, via: "panel" }, "wasm.delete", { name: module.name, sha256 });
    return module;
  }
}
