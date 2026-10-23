import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";
import { checkDecideInput, MAX_DECIDES_PER_RUN, MAX_QUESTIONS } from "../agent/decide.ts";
import { MAX_IMAGES_PER_RUN, measureText, renderCanvas } from "../canvas.ts";
import type { SandboxBindings, SandboxLimits, SandboxResult } from "../sandbox.ts";
import type { WorkerInput, WorkerMessage } from "./worker.ts";

// The one sandbox every piece of code runs in: a Wasm module in its own worker
// thread, killed when its time is up, with a 64 MiB memory cap written into
// the module and no way out but stdin, stdout, stderr and secretary.call.
// JavaScript (the agent's and rules') runs here too, as QuickJS compiled to
// Wasm (see sandbox.ts); uploaded modules run directly. Whatever a module asks
// of the host reaches only the bindings given here, so its reads and writes
// stay within what the person it runs for may do.

export const MAX_STDOUT = 4 * 1024 * 1024;
const MAX_STDERR = 64 * 1024;
const MAX_LOG_LINES = 100;
const MAX_LOG_LINE = 2000;

const WORKER_URL = new URL("./worker.ts", import.meta.url);

/** The bindings with an image-taking function, for modules that draw with their own libraries. */
export interface WasmBindings extends SandboxBindings {
  /** Keeps an image the module made and returns its id ("img1", ...). */
  image?: (data: Buffer, name: string) => Promise<string>;
}

export interface Execution {
  exitCode: number;
  stdout: Buffer;
  /** stderr, line by line, cut to size. */
  logs: string[];
}

/**
 * Runs a module once on `stdin`. Requests through secretary.call go to `host`.
 * Throws when the module traps, runs out of time or cannot start.
 */
export async function execute(module: WebAssembly.Module, stdin: Uint8Array, host: (request: string) => Promise<string>, wallTimeMs: number): Promise<Execution> {
  const { port1, port2 } = new MessageChannel();
  const signal = new SharedArrayBuffer(4);
  const flag = new Int32Array(signal);
  const input: WorkerInput = { module, stdin, port: port2, signal, maxStdout: MAX_STDOUT, maxStderr: MAX_STDERR };
  const worker = takeWorker();
  let healthy = false;
  try {
    const done = await new Promise<Extract<WorkerMessage, { type: "done" }>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`実行時間の上限(${wallTimeMs / 1000}秒)を超えました`)), wallTimeMs);
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
const MAX_IDLE_WORKERS = 4;
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
 * Runs an uploaded module for a rule. Its output is one JSON document on
 * stdout, { steps, state?, reply? }; reply() and the rest come through
 * secretary.call like the JS prelude's.
 */
export async function runWasm(module: WebAssembly.Module, bindings: WasmBindings, limits: SandboxLimits): Promise<SandboxResult> {
  let run: Execution;
  try {
    run = await execute(module, new TextEncoder().encode(wasmInput(bindings)), hostCalls(bindings, limits), limits.wallTimeMs);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), logs: [] };
  }
  const { logs } = run;
  if (run.exitCode !== 0) return { ok: false, error: `終了コード ${run.exitCode} で終わりました${logs.length ? `: ${logs.at(-1)!.slice(0, 300)}` : ""}`, logs };
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
  const o = out as { steps?: unknown; rules?: unknown; state?: unknown; reply?: unknown };
  if (o.reply !== undefined && o.reply !== null) {
    if (!bindings.reply) return { ok: false, error: "reply はコマンドの実行のときだけ使えます", logs };
    bindings.reply(String(o.reply));
  }
  return {
    ok: true,
    value: o.steps === undefined && o.rules === undefined ? null : { steps: o.steps ?? [], ...(o.rules !== undefined ? { rules: o.rules } : {}) },
    ...(bindings.state !== undefined && Object.hasOwn(o, "state") ? { state: { value: o.state ?? null } } : {}),
    logs,
  };
}

/** Answers a module's requests; every answer is JSON, { value } or { error }. */
export function hostCalls(bindings: WasmBindings, limits: SandboxLimits): (request: string) => Promise<string> {
  let gets = 0;
  let decides = 0;
  let images = 0;
  const image = (what: string) => {
    if (++images <= MAX_IMAGES_PER_RUN) return;
    throw new Error(what === "attachImage" ? `attachImage は1回の実行で${MAX_IMAGES_PER_RUN}回までです` : `画像を作れるのは1回の実行で${MAX_IMAGES_PER_RUN}枚までです(${what})`);
  };
  const decide = async (state: unknown, questions: unknown) => {
    if (!bindings.decide) throw new Error("判定モデル(または言語モデル)が設定されていないので judge・rank は使えません");
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
    async reply(r) {
      if (!bindings.reply) throw new Error("reply はコマンドの実行のときだけ使えます");
      bindings.reply(String(r.text ?? ""));
      return null;
    },
    async canvas(r) {
      if (!bindings.attach) throw new Error("createCanvas・attachImage はここでは使えません");
      image("attachImage");
      return bindings.attach(renderCanvas(r.width, r.height, r.ops), name(r.name));
    },
    async measure(r) {
      if (!bindings.attach) throw new Error("measureText はここでは使えません");
      return measureText(String(r.font ?? ""), String(r.text ?? ""));
    },
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
  return async (request) => {
    try {
      const r = JSON.parse(request) as Record<string, unknown>;
      const fn = typeof r?.fn === "string" && Object.hasOwn(fns, r.fn) ? fns[r.fn] : undefined;
      if (!fn) throw new Error(`fn は ${Object.keys(fns).join("・")} のどれかです`);
      return JSON.stringify({ value: (await fn(r)) ?? null });
    } catch (e) {
      return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
    }
  };
}
