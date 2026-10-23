import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { CANVAS_PRELUDE } from "./canvas.ts";
import { DECIDE_PRELUDE } from "./agent/decide.ts";
import type { Decide } from "./agent/decide.ts";
import { execute, hostCalls } from "./wasm/run.ts";

// Read-only code execution. JavaScript is one more Wasm module: QuickJS built
// for WASI (wasm/js-runner), run in the same sandbox as uploaded modules. The
// code can only reach the bindings passed in here, through secretary.call: no
// network, files, timers or host objects. A rule's code is compiled to QuickJS
// bytecode once and kept, so later runs skip the parse.

export interface SandboxBindings {
  guildId: string;
  actor: { kind: "user"; userId: string; via?: string };
  /** The event an event rule fired on; null for the agent's code. */
  event?: unknown;
  /** The rule's own values (ids it was made with); null for the agent's code. */
  params?: unknown;
  /** Which of the rule's triggers fired, e.g. "CHANNEL_CREATE"; null for the agent's code. */
  eventName?: string | null;
  /** Every event of the run, oldest first: one, or many for a debounced rule. */
  batch?: unknown[];
  /**
   * A rule's saved state, read as `state`; setState(value) replaces it for the
   * next run. Undefined (the agent's code) leaves both out.
   */
  state?: unknown;
  get: (route: string, query: Record<string, unknown>) => Promise<unknown>;
  /** Enables createCanvas()/attachImage(); takes the drawn PNG and returns the image's id. */
  attach?: (png: Buffer, name: string) => string;
  /** Enables reply(text) for a command's run: the words go back to whoever ran the command. */
  reply?: (text: string) => void;
  /** Enables judge()/rank() with the person's judge model (or language model). */
  decide?: Decide;
  /** Enables renderMath()/convertImage(); each returns the new image's id. Options arrive unchecked. */
  media?: {
    math: (tex: string, options: unknown, name: string) => Promise<string>;
    convert: (source: unknown, options: unknown, name: string) => Promise<string>;
  };
}

/** renderMath(tex, options, name) and convertImage(source, options, name) inside the sandbox. */
const MEDIA_PRELUDE = [
  "function renderMath(tex, options, name) { return __math(String(tex), JSON.stringify(options === undefined ? {} : options), name === undefined ? \"\" : String(name)); }",
  "function convertImage(source, options, name) { return __convert(JSON.stringify(source === undefined ? null : source), JSON.stringify(options === undefined ? {} : options), name === undefined ? \"\" : String(name)); }",
].join("\n");

export interface SandboxLimits {
  wallTimeMs: number;
  memoryBytes: number;
  maxGets: number;
}

export const AGENT_SANDBOX_LIMITS: SandboxLimits = { wallTimeMs: 30_000, memoryBytes: 64 * 1024 * 1024, maxGets: 200 };
/** Rules get as much as the agent's code; their run limits (per minute, failures in a row) keep them in check. The wall time includes waiting on discord.get. */
export const RULE_SANDBOX_LIMITS: SandboxLimits = AGENT_SANDBOX_LIMITS;

const PRELUDE = [
  "function call(op, args) { args = args || {}; return { id: args.id, op: op, path: args.path, query: args.query, body: args.body }; }",
  "function rule(def) { return def; }",
  "function plan(steps, rules) { return { steps: steps || [], rules: rules || [] }; }",
].join("\n");

/** The host functions the preludes call, over secretary.call. */
const HOST_SHIM = [
  "function __call(fn, args) { args = args || {}; args.fn = fn; var r = JSON.parse(__host(JSON.stringify(args))); if (r.error !== undefined) throw new Error(r.error); return r.value; }",
  "var discord = { get: function (route, opts) { return __call(\"get\", { route: String(route), query: (opts && opts.query) || {} }); } };",
  "function log() { __log(Array.prototype.map.call(arguments, function (a) { return JSON.stringify(a); }).join(\" \")); }",
  "function reply(text) { __call(\"reply\", { text: String(text) }); }",
  "function __attach(w, h, ops, name) { return __call(\"canvas\", { width: w, height: h, ops: JSON.parse(ops), name: name }); }",
  "function __measure(font, text) { return __call(\"measure\", { font: font, text: text }); }",
  "function __math(tex, options, name) { return __call(\"renderMath\", { tex: tex, options: JSON.parse(options), name: name }); }",
  "function __convert(source, options, name) { return __call(\"convertImage\", { source: JSON.parse(source), options: JSON.parse(options), name: name }); }",
  "function __judge(state, questions) { return JSON.stringify(__call(\"judge\", { state: JSON.parse(state), questions: JSON.parse(questions) })); }",
].join("\n");

/**
 * The whole program for one piece of code. Every helper is defined whatever the
 * run allows, so one compiled program serves every run of a rule; what a run
 * may not use fails with a message when called. The code is wrapped so it can
 * `return` its answer; setState keeps a JSON copy, so later changes to the
 * object do not leak into what is saved.
 */
export function program(code: string): string {
  return `${HOST_SHIM}\n${PRELUDE}\n${CANVAS_PRELUDE}\n${MEDIA_PRELUDE}\n${DECIDE_PRELUDE}\nvar __state; var setState = __stateful ? function (v) { __state = { value: v === undefined ? null : JSON.parse(JSON.stringify(v)) }; } : undefined;\nJSON.stringify({ value: (function () {\n${code}\n})(), state: __state })`;
}

const JS_HEAP_MAX = 48 * 1024 * 1024;
const COMPILE_LIMIT_MS = 10_000;

let runner: Promise<{ module: WebAssembly.Module; sha256: string }> | null = null;

/** The JS engine module, compiled once and kept. Called at startup; runs call it too. */
export function precompileJsEngine(): Promise<{ module: WebAssembly.Module; sha256: string }> {
  runner ??= (async () => {
    const bytes = await readFile(new URL("./wasm/js-runner.wasm", import.meta.url));
    return { module: await WebAssembly.compile(bytes), sha256: createHash("sha256").update(bytes).digest("hex") };
  })();
  runner.catch(() => (runner = null));
  return runner;
}

/** Where compiled programs are kept between runs and restarts; the key covers the engine build and the program. */
export interface BytecodeCache {
  get(key: string): Buffer | undefined;
  set(key: string, data: Buffer): void;
}

let bytecodeCache: BytecodeCache | null = null;
export function setBytecodeCache(cache: BytecodeCache | null): void {
  bytecodeCache = cache;
}

async function cacheKey(code: string): Promise<string> {
  const { sha256 } = await precompileJsEngine();
  return createHash("sha256").update(sha256).update("\0").update(program(code)).digest("hex");
}

function header(value: Record<string, unknown>): string {
  return `${JSON.stringify(value)}\n`;
}

/** Compiles code to QuickJS bytecode inside the sandbox; a syntax error comes back as an Error. */
export async function compileJs(code: string): Promise<Buffer> {
  const { module } = await precompileJsEngine();
  const run = await execute(module, Buffer.concat([Buffer.from(header({ mode: "compile", memory: JS_HEAP_MAX })), Buffer.from(program(code))]), async () => JSON.stringify({ error: "コンパイル中は使えません" }), COMPILE_LIMIT_MS);
  if (run.exitCode !== 0) throw new Error(run.logs.at(-1) ?? `コンパイルに失敗しました(${run.exitCode})`);
  return run.stdout;
}

/** Compiles a rule's code ahead of its first run, unless it is kept already. */
export async function precompileJs(code: string): Promise<boolean> {
  if (!bytecodeCache) return false;
  const key = await cacheKey(code);
  if (bytecodeCache.get(key)) return false;
  bytecodeCache.set(key, await compileJs(code));
  return true;
}

export interface SandboxResult {
  ok: boolean;
  value?: unknown;
  /** Set when the code called setState: the value to keep for the next run. */
  state?: { value: unknown };
  error?: string;
  logs: string[];
}

/**
 * Runs code once. With `cache`, the code's compiled form is used and kept
 * (rules, whose code runs many times); otherwise it is parsed for this run.
 */
export async function runSandboxed(code: string, bindings: SandboxBindings, limits: SandboxLimits, options: { cache?: boolean } = {}): Promise<SandboxResult> {
  const stateful = bindings.state !== undefined;
  const globals = {
    guild: bindings.guildId,
    actor: bindings.actor,
    event: bindings.event ?? null,
    params: bindings.params ?? null,
    eventName: bindings.eventName ?? null,
    batch: bindings.batch ?? null,
    __stateful: stateful,
    ...(stateful ? { state: bindings.state } : {}),
  };
  let output: string;
  let logs: string[] = [];
  try {
    const { module } = await precompileJsEngine();
    let payload: Buffer | undefined;
    if (options.cache && bytecodeCache) {
      const key = await cacheKey(code);
      payload = bytecodeCache.get(key);
      if (!payload) {
        try {
          payload = await compileJs(code);
          bytecodeCache.set(key, payload);
        } catch {
          payload = undefined; // The source run below reports the error.
        }
      }
    }
    const mode = payload ? "bytecode" : "source";
    const stdin = Buffer.concat([Buffer.from(header({ mode, memory: Math.min(limits.memoryBytes, JS_HEAP_MAX), globals })), payload ?? Buffer.from(program(code))]);
    const run = await execute(module, stdin, hostCalls(bindings, limits), limits.wallTimeMs);
    logs = run.logs;
    if (run.exitCode !== 0) return { ok: false, error: `JSの実行が止まりました(${run.exitCode})${logs.length ? `: ${logs.at(-1)}` : ""}`, logs };
    output = run.stdout.toString("utf8");
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), logs };
  }
  let parsed: { value?: unknown; state?: { value: unknown }; __error?: string };
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    return { ok: false, error: "コードの結果を読めませんでした", logs };
  }
  if (parsed.__error !== undefined) return { ok: false, error: parsed.__error, logs };
  return { ok: true, value: parsed.value, ...(stateful && parsed.state ? { state: parsed.state } : {}), logs };
}
