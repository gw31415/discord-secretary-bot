import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";
import { checkDecideInput, MAX_DECIDES_PER_RUN, MAX_QUESTIONS } from "../agent/decide.ts";
import { MAX_IMAGES_PER_RUN, measureText, renderCanvas } from "../canvas.ts";
import type { SandboxBindings, SandboxLimits, SandboxResult } from "../sandbox.ts";
import type { WorkerInput, WorkerMessage } from "./worker.ts";

// The one sandbox every piece of code runs in: a Wasm module in its own worker
// thread, killed when its time is up, with a 64 MiB memory cap written into
// the module and no way out but stdin, stdout, stderr and secretary.call.
// Every rule runs as a Program: a module and what goes ahead of the run's
// input on its stdin. An uploaded module is just the module; JavaScript is the
// JS engine with the program ahead of the input (see sandbox.ts). Both read
// the same input and write the same output. Whatever a module asks of the host
// reaches only the bindings given here, so its reads and writes stay within
// what the person it runs for may do.

export const MAX_STDOUT = 4 * 1024 * 1024;
/** judge() or rank() without a judge model; for a command, the model of whoever ran it. */
export const NO_DECIDE = "判定モデル(または言語モデル)が設定されていないので judge・rank は使えません(`/settings` の「モデル」で選べます)";
const MAX_STDERR = 64 * 1024;
const MAX_LOG_LINES = 100;
const MAX_LOG_LINE = 2000;

const WORKER_URL = new URL("./worker.ts", import.meta.url);

/** The bindings with an image-taking function, for modules that draw with their own libraries. */
export interface WasmBindings extends SandboxBindings {
  /** Keeps an image the module made and returns its id ("img1", ...). */
  image?: (data: Buffer, name: string) => Promise<string>;
}

/** A module to run and the bytes it reads on stdin ahead of the run's input. */
export interface Program {
  module: WebAssembly.Module;
  prefix?: Uint8Array;
  /** The JS engine, which may also use the host functions its own preludes need (canvas, measure). */
  engine?: boolean;
}

export interface Execution {
  exitCode: number;
  stdout: Buffer;
  /** stderr, line by line, cut to size. */
  logs: string[];
}

/**
 * Runs a module once on `stdin`. Requests through secretary.call go to `host`.
 * `nested` is for a module run from inside another run, which already holds a slot.
 * Throws when the module traps, runs out of time or cannot start.
 */
export async function execute(module: WebAssembly.Module, stdin: Uint8Array, host: (request: string) => Promise<string>, wallTimeMs: number, nested = false): Promise<Execution> {
  const deadline = Date.now() + wallTimeMs;
  const timeUp = () => new Error(`実行時間の上限(${Math.round(wallTimeMs / 100) / 10}秒)を超えました`);
  // A run started by a running module (runWasm) uses that module's slot, which waits on it.
  if (nested) return executeIn(module, stdin, host, deadline, timeUp);
  if (!(await slot(deadline))) throw timeUp();
  try {
    return await executeIn(module, stdin, host, deadline, timeUp);
  } finally {
    release();
  }
}

// At most this many modules run at once; the rest wait their turn, and the
// wait counts toward their time.
const MAX_RUNNING = 4;
let running = 0;
const waiting: Array<() => void> = [];

/** Waits for a free slot until `deadline`; false when time ran out first. */
function slot(deadline: number): Promise<boolean> {
  if (running < MAX_RUNNING) {
    running++;
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const take = () => {
      clearTimeout(timer);
      running++;
      resolve(true);
    };
    const timer = setTimeout(() => {
      waiting.splice(waiting.indexOf(take), 1);
      resolve(false);
    }, Math.max(0, deadline - Date.now()));
    waiting.push(take);
  });
}

function release(): void {
  running--;
  waiting.shift()?.();
}

async function executeIn(module: WebAssembly.Module, stdin: Uint8Array, host: (request: string) => Promise<string>, deadline: number, timeUp: () => Error): Promise<Execution> {
  const { port1, port2 } = new MessageChannel();
  const signal = new SharedArrayBuffer(4);
  const flag = new Int32Array(signal);
  const input: WorkerInput = { module, stdin, port: port2, signal, maxStdout: MAX_STDOUT, maxStderr: MAX_STDERR };
  const worker = takeWorker();
  let healthy = false;
  try {
    const done = await new Promise<Extract<WorkerMessage, { type: "done" }>>((resolve, reject) => {
      const timer = setTimeout(() => reject(timeUp()), Math.max(0, deadline - Date.now()));
      const finish = (fn: () => void) => {
        clearTimeout(timer);
        worker.off("error", onError);
        worker.off("exit", onExit);
        fn();
      };
      const onError = (e: Error) => finish(() => reject(e));
      const onExit = (code: number) => {
        // The result may be posted just before the thread ends.
        const last = receiveMessageOnPort(port1)?.message as WorkerMessage | undefined;
        finish(() => (last?.type === "done" ? resolve(last) : reject(new Error(`Wasmの実行が止まりました(${code})`))));
      };
      worker.on("error", onError);
      worker.on("exit", onExit);
      port1.on("message", (message: WorkerMessage) => {
        if (message.type === "done") {
          finish(() => resolve(message));
          return;
        }
        void host(message.request).then((response) => {
          port1.postMessage({ response });
          Atomics.store(flag, 0, 1);
          Atomics.notify(flag, 0);
        });
      });
      worker.postMessage(input, [port2 as never]);
    });
    healthy = true;
    if (done.error) throw new Error(done.error);
    const logs = new TextDecoder()
      .decode(done.stderr)
      .split("\n")
      .filter((l) => l.trim())
      .slice(0, MAX_LOG_LINES)
      .map((l) => l.slice(0, MAX_LOG_LINE));
    return { exitCode: done.exitCode, stdout: Buffer.from(done.stdout), logs };
  } finally {
    port1.close();
    // A thread that ran out of time (or broke) is thrown away; one that finished waits for the next run.
    if (healthy) giveBack(worker);
    else void worker.terminate();
  }
}

// Starting a thread costs tens of milliseconds, so finished ones are kept for the next run.
const MAX_IDLE_WORKERS = MAX_RUNNING;
const idle: Worker[] = [];

function takeWorker(): Worker {
  return idle.pop() ?? spawn();
}

function spawn(): Worker {
  const worker = new Worker(WORKER_URL, { resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8 } });
  worker.unref();
  worker.on("exit", () => {
    const i = idle.indexOf(worker);
    if (i >= 0) idle.splice(i, 1);
  });
  return worker;
}

function giveBack(worker: Worker): void {
  if (idle.length < MAX_IDLE_WORKERS) idle.push(worker);
  else void worker.terminate();
}

/** Starts threads ahead of the first runs. */
export function warmWorkers(count = 2): void {
  while (idle.length < Math.min(count, MAX_IDLE_WORKERS)) idle.push(spawn());
}

// V8 compiles a module's functions the first time they are called, so a
// module's first run takes 5 to 70 ms more than the next ones (more for big
// modules such as Go's). Once per module, a run with a made-up input and a
// host that refuses every request does that before the first event. Whatever
// it writes is thrown away, and it can reach nothing: every request fails.
const WARM_TIME_MS = 2_000;
const warmed = new WeakSet<WebAssembly.Module>();
let warming: Promise<void> = Promise.resolve();

/** Runs the program once, in the background and one module at a time, so its first real run is not its slowest. */
export function warmUp(program: Program): Promise<void> {
  if (warmed.has(program.module)) return warming;
  warmed.add(program.module);
  const input = new TextEncoder().encode(JSON.stringify({ guild: "0", actor: { kind: "user", userId: "0" }, eventName: null, event: null, batch: [], params: null, state: null }));
  const stdin = program.prefix ? Buffer.concat([program.prefix, input]) : input;
  const refuse = async () => JSON.stringify({ error: "準備のための実行です" });
  warming = warming.then(() => execute(program.module, stdin, refuse, WARM_TIME_MS).then(() => undefined, () => undefined));
  return warming;
}

/** What an uploaded module reads on stdin. */
export function wasmInput(bindings: SandboxBindings): string {
  return JSON.stringify({
    guild: bindings.guildId,
    actor: bindings.actor,
    eventName: bindings.eventName ?? null,
    event: bindings.event ?? null,
    batch: bindings.batch ?? null,
    params: bindings.params ?? null,
    state: bindings.state === undefined ? null : bindings.state,
  });
}

/**
 * Runs a rule's program once. The output is one JSON document on stdout,
 * { steps?, state?, reply? }, the same for JS and uploaded modules.
 */
export async function runModule(program: Program, bindings: WasmBindings, limits: SandboxLimits): Promise<SandboxResult> {
  const input = new TextEncoder().encode(wasmInput(bindings));
  const stdin = program.prefix ? Buffer.concat([program.prefix, input]) : input;
  let run: Execution;
  try {
    run = await execute(program.module, stdin, hostCalls(bindings, limits, program.engine), limits.wallTimeMs);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), logs: [] };
  }
  const { logs } = run;
  // A failed run's last line on stderr is its error.
  if (run.exitCode !== 0) return { ok: false, error: logs.at(-1)?.slice(0, 500) ?? `終了コード ${run.exitCode} で終わりました`, logs: logs.slice(0, -1) };
  const text = run.stdout.toString("utf8").trim();
  if (!text) return { ok: true, value: null, logs };
  let out: unknown;
  try {
    out = JSON.parse(text);
  } catch {
    return { ok: false, error: `標準出力がJSONではありません: ${text.slice(0, 200)}`, logs };
  }
  if (out === null) return { ok: true, value: null, logs };
  if (typeof out !== "object" || Array.isArray(out)) return { ok: false, error: "標準出力は { \"steps\": [...] } の形のJSONにしてください", logs };
  const o = out as { steps?: unknown; state?: unknown; reply?: unknown };
  if (o.reply !== undefined && o.reply !== null) {
    if (!bindings.reply) return { ok: false, error: "reply はコマンドの実行のときだけ使えます", logs };
    bindings.reply(String(o.reply));
  }
  return {
    ok: true,
    value: o.steps === undefined ? null : { steps: o.steps },
    ...(bindings.state !== undefined && Object.hasOwn(o, "state") ? { state: { value: o.state ?? null } } : {}),
    logs,
  };
}

/**
 * Answers a module's requests; every answer is JSON, { value } or { error }.
 * The public ABI is get, judge, rank, renderMath, convertImage, image and
 * runWasm (docs/wasm.md); canvas and measure serve the JS engine's createCanvas.
 * A module run with runWasm reaches the same bindings and limits, all but runWasm.
 */
export function hostCalls(bindings: WasmBindings, limits: SandboxLimits, engine = false): (request: string) => Promise<string> {
  const deadline = Date.now() + limits.wallTimeMs;
  let gets = 0;
  let decides = 0;
  let images = 0;
  const image = (what: string) => {
    if (++images <= MAX_IMAGES_PER_RUN) return;
    throw new Error(what === "attachImage" ? `attachImage は1回の実行で${MAX_IMAGES_PER_RUN}回までです` : `画像を作れるのは1回の実行で${MAX_IMAGES_PER_RUN}枚までです(${what})`);
  };
  const decide = async (state: unknown, questions: unknown) => {
    if (!bindings.decide) throw new Error(NO_DECIDE);
    if (++decides > MAX_DECIDES_PER_RUN) throw new Error(`judge・rank は1回の実行で${MAX_DECIDES_PER_RUN}回までです`);
    const input = checkDecideInput(state, questions);
    return bindings.decide(input.state, input.questions);
  };
  const name = (v: unknown) => (v === undefined || v === null ? "" : String(v));
  const fns: Record<string, (r: Record<string, any>) => Promise<unknown>> = {
    async get(r) {
      if (++gets > limits.maxGets) throw new Error(`discord.get は1回の実行で${limits.maxGets}回までです`);
      if (typeof r.route !== "string") throw new Error("get には route(文字列)が必要です");
      return (await bindings.get(r.route, (r.query ?? {}) as Record<string, unknown>)) ?? null;
    },
    async judge(r) {
      return decide(r.state ?? {}, r.questions ?? {});
    },
    async rank(r) {
      const items = r.items;
      if (!Array.isArray(items) || items.length === 0) return [];
      if (items.length > MAX_QUESTIONS) throw new Error(`rank は1回に${MAX_QUESTIONS}件までです`);
      const scale = Array.isArray(r.levels) ? r.levels : ["まったく当てはまらない", "あまり当てはまらない", "どちらとも言えない", "よく当てはまる", "とてもよく当てはまる"];
      const questions = Object.fromEntries(items.map((_, i) => [`item${i}`, { type: "score", instructions: `${String(r.instructions)}(対象は state.items[${i}])`, criteria: scale }]));
      const answers = (await decide({ items }, questions)) as Record<string, { score: number }>;
      return items.map((item, i) => ({ item, score: answers[`item${i}`]!.score })).sort((a, b) => b.score - a.score);
    },
  };
  const engineFns: typeof fns = {
    async canvas(r) {
      if (!bindings.attach) throw new Error("createCanvas・attachImage はここでは使えません");
      image("attachImage");
      return bindings.attach(renderCanvas(r.width, r.height, r.ops), name(r.name));
    },
    async measure(r) {
      if (!bindings.attach) throw new Error("measureText はここでは使えません");
      return measureText(String(r.font ?? ""), String(r.text ?? ""));
    },
  };
  const publicFns: typeof fns = {
    async renderMath(r) {
      if (!bindings.media) throw new Error("renderMath はここでは使えません");
      image("renderMath");
      return bindings.media.math(String(r.tex ?? ""), r.options ?? {}, name(r.name));
    },
    async convertImage(r) {
      if (!bindings.media) throw new Error("convertImage はここでは使えません");
      image("convertImage");
      return bindings.media.convert(r.source ?? null, r.options ?? {}, name(r.name));
    },
    async image(r) {
      if (!bindings.image) throw new Error("image はここでは使えません");
      if (typeof r.data !== "string") throw new Error("image には data(画像のBase64)が必要です");
      image("image");
      return bindings.image(Buffer.from(r.data, "base64"), name(r.name));
    },
  };
  const answer = async (request: string, own: typeof fns) => {
    try {
      const r = JSON.parse(request) as Record<string, unknown>;
      const fn = typeof r?.fn === "string" && Object.hasOwn(own, r.fn) ? own[r.fn] : undefined;
      if (!fn) throw new Error(`fn は ${Object.keys(own).join("・")} のどれかです`);
      return JSON.stringify({ value: (await fn(r)) ?? null });
    } catch (e) {
      return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
    }
  };
  // The module it runs reads what run_wasm's would and has the time left.
  const nestedFns = { ...fns, ...publicFns };
  publicFns.runWasm = async (r) => {
    if (!bindings.wasm) throw new Error("runWasm はここでは使えません");
    if (typeof r.module !== "string") throw new Error("runWasm には module(モジュール名か sha256)が必要です");
    if (r.stdin !== undefined && r.stdin !== null && typeof r.stdin !== "string") throw new Error("runWasm の stdin は文字列にしてください");
    const module = await bindings.wasm(r.module);
    const stdin = r.stdin ?? wasmInput({ ...bindings, eventName: null, event: r.input ?? null, batch: undefined, params: null, state: null });
    const run = await execute(module, new TextEncoder().encode(stdin), (request) => answer(request, nestedFns), Math.max(0, deadline - Date.now()), true);
    return { exitCode: run.exitCode, stdout: run.stdout.toString("utf8"), logs: run.logs };
  };
  Object.assign(fns, publicFns);
  if (engine) Object.assign(fns, engineFns);
  return (request) => answer(request, fns);
}
