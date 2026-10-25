import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { CANVAS_PRELUDE } from "./canvas.ts";
import { DECIDE_PRELUDE } from "./agent/decide.ts";
import type { Decide } from "./agent/decide.ts";
import { execute, hostCalls, runModule, warmUp, wasmInput } from "./wasm/run.ts";
import type { Program } from "./wasm/run.ts";

// Read-only code execution. JavaScript is one more Wasm module: QuickJS built
// for WASI (wasm/js-runner), run in the same sandbox and with the same ABI as
// uploaded modules. A JS program is that module plus the program, which goes
// ahead of the run's input on stdin; a rule's program is compiled to QuickJS
// bytecode once and kept. The code can only reach the bindings passed in
// here, through secretary.call: no network, files, timers or host objects.

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
  /** Includes waiting for a free slot and for the host's answers. */
  wallTimeMs: number;
  maxGets: number;
}

/** One limit for all code, the agent's and rules'; rules are kept in check by their run limits (per minute, failures in a row). Memory is capped by the runner (64 MiB). */
export const SANDBOX_LIMITS: SandboxLimits = { wallTimeMs: 30_000, maxGets: 200 };

/** call() and plan() as both kinds of program have them. */
const CALL_PRELUDE = "function call(op, args) { args = args || {}; return { id: args.id, op: op, path: args.path, query: args.query, body: args.body }; }";

/** The host functions the preludes call, over secretary.call. canvas and measure are the runner's own (see wasm/run.ts). */
const HOST_SHIM = [
  "function __call(fn, args) { args = args || {}; args.fn = fn; var r = JSON.parse(__host(JSON.stringify(args))); if (r.error !== undefined) throw new Error(r.error); return r.value; }",
  "var discord = { get: function (route, opts) { return __call(\"get\", { route: String(route), query: (opts && opts.query) || {} }); } };",
  "function log() { __log(Array.prototype.map.call(arguments, function (a) { return JSON.stringify(a); }).join(\" \")); }",
  "function __attach(w, h, ops, name) { return __call(\"canvas\", { width: w, height: h, ops: JSON.parse(ops), name: name }); }",
  "function __measure(font, text) { return __call(\"measure\", { font: font, text: text }); }",
  "function __math(tex, options, name) { return __call(\"renderMath\", { tex: tex, options: JSON.parse(options), name: name }); }",
  "function __convert(source, options, name) { return __call(\"convertImage\", { source: JSON.parse(source), options: JSON.parse(options), name: name }); }",
  "function __judge(state, questions) { return JSON.stringify(__call(\"judge\", { state: JSON.parse(state), questions: JSON.parse(questions) })); }",
].join("\n");

const COMMON = `${HOST_SHIM}\n${CALL_PRELUDE}\n${CANVAS_PRELUDE}\n${MEDIA_PRELUDE}\n${DECIDE_PRELUDE}`;

/**
 * The agent's program: its code may also propose rules (`plan(steps, rules)`),
 * and its answer is any JSON value. The code is wrapped so it can `return`.
 */
export function program(code: string): string {
  return `${COMMON}
function rule(def) { return def; }
function plan(steps, rules) { return { steps: steps || [], rules: rules || [] }; }
JSON.stringify({ value: (function () {\n${code}\n})() })`;
}

/**
 * A rule's program. It writes what every rule's module writes on stdout,
 * { steps?, state?, reply? }: steps from `return plan([...])`, state from
 * setState (a JSON copy, so later changes to the object are not kept), reply
 * from reply(text).
 */
export function ruleProgram(code: string): string {
  return `${COMMON}
function plan(steps) { return { steps: steps || [] }; }
var __state; function setState(v) { __state = { value: v === undefined ? null : JSON.parse(JSON.stringify(v)) }; }
var __reply = null; function reply(text) { __reply = (__reply === null ? "" : __reply + "\\n") + String(text); }
var __r = (function () {\n${code}\n})();
if (__r !== undefined && __r !== null && (typeof __r !== "object" || Array.isArray(__r) || !Array.isArray(__r.steps))) throw new TypeError("コードは plan([...]) を return してください");
var __out = {};
if (__r) __out.steps = __r.steps;
if (__state) __out.state = __state.value;
if (__reply !== null) __out.reply = __reply;
JSON.stringify(__out)`;
}

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

/** The runner's stdin ahead of the run's input: a header line, then the program. */
function prefix(mode: "compile" | "source" | "bytecode", body: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${JSON.stringify({ mode, size: body.length })}\n`), body]);
}

async function compileText(text: string): Promise<Buffer> {
  const { module } = await precompileJsEngine();
  const run = await execute(module, prefix("compile", Buffer.from(text)), async () => JSON.stringify({ error: "コンパイル中は使えません" }), COMPILE_LIMIT_MS);
  if (run.exitCode !== 0) throw new Error(run.logs.at(-1) ?? `コンパイルに失敗しました(${run.exitCode})`);
  return run.stdout;
}

/** Compiles code to QuickJS bytecode inside the sandbox; a syntax error comes back as an Error. */
export async function compileJs(code: string): Promise<Buffer> {
  return compileText(program(code));
}

async function cacheKey(code: string): Promise<string> {
  const { sha256 } = await precompileJsEngine();
  return createHash("sha256").update(sha256).update("\0").update(ruleProgram(code)).digest("hex");
}

/** Compiles a rule's code ahead of its first run, unless it is kept already. */
export async function precompileJs(code: string): Promise<boolean> {
  if (!bytecodeCache) return false;
  const key = await cacheKey(code);
  if (bytecodeCache.get(key)) return false;
  bytecodeCache.set(key, await compileText(ruleProgram(code)));
  return true;
}

/**
 * A rule's JS as a program to run: the engine, with the code's bytecode
 * (compiled once and kept) or, when it does not compile, its source, so the
 * run reports the syntax error.
 */
export async function jsProgram(code: string): Promise<Program> {
  const { module } = await precompileJsEngine();
  let bytecode: Buffer | undefined;
  if (bytecodeCache) {
    const key = await cacheKey(code);
    bytecode = bytecodeCache.get(key);
    if (!bytecode) {
      try {
        bytecode = await compileText(ruleProgram(code));
        bytecodeCache.set(key, bytecode);
      } catch {
        bytecode = undefined;
      }
    }
  }
  return { module, prefix: bytecode ? prefix("bytecode", bytecode) : prefix("source", Buffer.from(ruleProgram(code))), engine: true };
}

/** One run through the engine's usual paths (globals, JSON, strings, a refused request, an error), so no rule's first run is the slow one. */
export async function warmJsEngine(): Promise<void> {
  const code = [
    "var names = [];",
    "for (var k in (event || {})) names.push(String(k).toUpperCase());",
    "try { discord.get(\"/guilds/\" + guild); } catch (e) { log(e.message); }",
    "var o = JSON.parse(JSON.stringify({ names: names, at: new Date().toISOString(), n: [3, 1, 2].sort() }));",
    "if (state === null) setState(o);",
    "return plan([call(\"POST /channels/{channel}/messages\", { path: { channel: \"0\" }, body: { content: o.names.join(\",\").replace(/,/g, \" \").slice(0, 10) } })]);",
  ].join("\n");
  await jsProgram(code).then(warmUp, () => undefined);
}

/** Runs a rule's code once from source, as a rule run would (trial runs and tests). */
export async function runRuleCode(code: string, bindings: SandboxBindings, limits: SandboxLimits = SANDBOX_LIMITS): Promise<SandboxResult> {
  const { module } = await precompileJsEngine();
  return runModule({ module, prefix: prefix("source", Buffer.from(ruleProgram(code))), engine: true }, bindings, limits);
}

export interface SandboxResult {
  ok: boolean;
  value?: unknown;
  /** Set when the code called setState: the value to keep for the next run. */
  state?: { value: unknown };
  error?: string;
  logs: string[];
}

/** Runs the agent's code once; its answer is any JSON value. */
export async function runSandboxed(code: string, bindings: SandboxBindings, limits: SandboxLimits = SANDBOX_LIMITS): Promise<SandboxResult> {
  let output: string;
  let logs: string[] = [];
  try {
    const { module } = await precompileJsEngine();
    const stdin = Buffer.concat([prefix("source", Buffer.from(program(code))), Buffer.from(wasmInput(bindings))]);
    const run = await execute(module, stdin, hostCalls(bindings, limits, true), limits.wallTimeMs);
    logs = run.logs;
    if (run.exitCode !== 0) return { ok: false, error: logs.at(-1) ?? `JSの実行が止まりました(${run.exitCode})`, logs: logs.slice(0, -1) };
    output = run.stdout.toString("utf8");
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), logs };
  }
  try {
    return { ok: true, value: (JSON.parse(output) as { value?: unknown }).value, logs };
  } catch {
    return { ok: false, error: "コードの結果を読めませんでした", logs };
  }
}
