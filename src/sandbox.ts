import { newAsyncContext, shouldInterruptAfterDeadline } from "quickjs-emscripten";
import type { QuickJSAsyncContext, QuickJSHandle } from "quickjs-emscripten";
import { CANVAS_PRELUDE, MAX_IMAGES_PER_RUN, measureText, renderCanvas } from "./canvas.ts";

// Read-only code execution. The code runs in QuickJS inside WebAssembly and can
// only reach the bindings passed in here: no network, files, timers or host objects.

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
/** A rule runs on every matching event, so it gets less. The wall time includes waiting on discord.get. */
export const RULE_SANDBOX_LIMITS: SandboxLimits = { wallTimeMs: 10_000, memoryBytes: 64 * 1024 * 1024, maxGets: 50 };

const PRELUDE = [
  "function call(op, args) { args = args || {}; return { id: args.id, op: op, path: args.path, query: args.query, body: args.body }; }",
  "function rule(def) { return def; }",
  "function plan(steps, rules) { return { steps: steps || [], rules: rules || [] }; }",
].join("\n");

export interface SandboxResult {
  ok: boolean;
  value?: unknown;
  /** Set when the code called setState: the value to keep for the next run. */
  state?: { value: unknown };
  error?: string;
  logs: string[];
}

function toHandle(vm: QuickJSAsyncContext, value: unknown): QuickJSHandle {
  if (value === undefined) return vm.undefined.dup();
  const json = vm.newString(JSON.stringify(value));
  const parse = vm.getProp(vm.getProp(vm.global, "JSON"), "parse");
  const result = vm.unwrapResult(vm.callFunction(parse, vm.undefined, json));
  json.dispose();
  parse.dispose();
  return result;
}

export async function runSandboxed(code: string, bindings: SandboxBindings, limits: SandboxLimits): Promise<SandboxResult> {
  const vm = await newAsyncContext();
  const logs: string[] = [];
  let gets = 0;
  try {
    vm.runtime.setMemoryLimit(limits.memoryBytes);
    vm.runtime.setMaxStackSize(1024 * 1024);
    vm.runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + limits.wallTimeMs));

    vm.newString(bindings.guildId).consume((h) => vm.setProp(vm.global, "guild", h));
    toHandle(vm, bindings.actor).consume((h) => vm.setProp(vm.global, "actor", h));
    toHandle(vm, bindings.event ?? null).consume((h) => vm.setProp(vm.global, "event", h));
    toHandle(vm, bindings.params ?? null).consume((h) => vm.setProp(vm.global, "params", h));
    toHandle(vm, bindings.eventName ?? null).consume((h) => vm.setProp(vm.global, "eventName", h));
    toHandle(vm, bindings.batch ?? null).consume((h) => vm.setProp(vm.global, "batch", h));
    const stateful = bindings.state !== undefined;
    if (stateful) toHandle(vm, bindings.state).consume((h) => vm.setProp(vm.global, "state", h));

    const discord = vm.newObject();
    vm.newAsyncifiedFunction("get", async (routeHandle, optsHandle) => {
      if (++gets > limits.maxGets) throw new Error(`discord.get は1回の実行で${limits.maxGets}回までです`);
      const route = vm.getString(routeHandle);
      const opts = optsHandle ? (vm.dump(optsHandle) as { query?: Record<string, unknown> } | undefined) : undefined;
      return toHandle(vm, await bindings.get(route, opts?.query ?? {}));
    }).consume((fn) => vm.setProp(discord, "get", fn));
    vm.setProp(vm.global, "discord", discord);
    discord.dispose();

    let attached = 0;
    if (bindings.attach) {
      const attach = bindings.attach;
      vm.newFunction("__attach", (w, h, opsJson, name) => {
        if (++attached > MAX_IMAGES_PER_RUN) throw new Error(`attachImage は1回の実行で${MAX_IMAGES_PER_RUN}回までです`);
        const png = renderCanvas(vm.dump(w), vm.dump(h), JSON.parse(vm.getString(opsJson)));
        return vm.newString(attach(png, vm.getString(name)));
      }).consume((fn) => vm.setProp(vm.global, "__attach", fn));
      vm.newFunction("__measure", (font, text) => toHandle(vm, measureText(vm.getString(font), vm.getString(text)))).consume((fn) => vm.setProp(vm.global, "__measure", fn));
    }
    if (bindings.media) {
      const media = bindings.media;
      const count = (what: string) => {
        if (++attached > MAX_IMAGES_PER_RUN) throw new Error(`画像を作れるのは1回の実行で${MAX_IMAGES_PER_RUN}枚までです(${what})`);
      };
      vm.newAsyncifiedFunction("__math", async (tex, options, name) => {
        count("renderMath");
        return vm.newString(await media.math(vm.getString(tex), JSON.parse(vm.getString(options)), vm.getString(name)));
      }).consume((fn) => vm.setProp(vm.global, "__math", fn));
      vm.newAsyncifiedFunction("__convert", async (source, options, name) => {
        count("convertImage");
        return vm.newString(await media.convert(JSON.parse(vm.getString(source)), JSON.parse(vm.getString(options)), vm.getString(name)));
      }).consume((fn) => vm.setProp(vm.global, "__convert", fn));
    }

    if (bindings.reply) {
      const reply = bindings.reply;
      vm.newFunction("reply", (text) => {
        reply(String(vm.dump(text)));
      }).consume((fn) => vm.setProp(vm.global, "reply", fn));
    }

    vm.newFunction("log", (...args) => {
      logs.push(args.map((a) => JSON.stringify(vm.dump(a))).join(" ").slice(0, 2000));
    }).consume((fn) => vm.setProp(vm.global, "log", fn));

    // Wrapped so the code can `return` its answer; JSON keeps host and guest values apart.
    // call()/rule()/plan() only build plain objects: a returned plan is a proposal, not a write.
    // setState keeps a JSON copy, so later changes to the object do not leak into what is saved.
    const prelude = [PRELUDE, ...(bindings.attach ? [CANVAS_PRELUDE] : []), ...(bindings.media ? [MEDIA_PRELUDE] : [])].join("\n");
    const wrapped = stateful
      ? `${prelude}\nvar __state; function setState(v) { __state = { value: v === undefined ? null : JSON.parse(JSON.stringify(v)) }; }\nJSON.stringify({ value: (function () {\n${code}\n})(), state: __state })`
      : `${prelude}\nJSON.stringify((function () {\n${code}\n})())`;
    const result = await vm.evalCodeAsync(wrapped, "agent.js");
    if (result.error) {
      const err = vm.dump(result.error) as { name?: string; message?: string } | string;
      result.error.dispose();
      return { ok: false, error: typeof err === "string" ? err : `${err.name ?? "Error"}: ${err.message ?? ""}`, logs };
    }
    const json = vm.getString(result.value);
    result.value.dispose();
    const parsed = json === undefined || json === "undefined" ? undefined : JSON.parse(json);
    if (!stateful) return { ok: true, value: parsed, logs };
    const out = parsed as { value?: unknown; state?: { value: unknown } };
    return { ok: true, value: out.value, ...(out.state ? { state: out.state } : {}), logs };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), logs };
  } finally {
    vm.dispose();
  }
}
