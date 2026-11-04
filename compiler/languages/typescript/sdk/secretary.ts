// The bot's side of the ABI for TypeScript (scriptc): read the run's input,
// call the host, write the result. build.sh adds this file next to the
// sources unless they bring their own secretary.ts.
import { readFileSync } from "node:fs";

// Imports of the compiled module, supplied by sdk/adapter.wat: secretaryCall is
// secretary.call, secretaryOutput writes to stdout (console.log goes to the log).
declare function secretaryCall(request: string, response: Uint8Array): number;
declare function secretaryOutput(text: string): void;

export interface Actor {
  kind: string;
  userId?: string;
  via?: string;
}

export interface BatchItem {
  eventName: string;
  event: unknown;
}

/** The run's input. event, params and state are whatever JSON came; cast them to your own types. */
export interface Input {
  guild: string;
  actor: Actor;
  eventName: string | null;
  event: unknown;
  batch: BatchItem[] | null;
  params: unknown;
  state: unknown;
}

export interface Step {
  id?: string;
  op: string;
  path?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
}

/** What the run writes: { steps, state?, reply?, response?, later? }. */
export interface Output {
  steps?: Step[];
  state?: unknown;
  reply?: string;
  response?: unknown;
  later?: (number | string)[];
}

/** The host refused a call: the text is the reason it gave. */
export class HostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostError";
  }
}

let inputText: string | undefined = undefined;

/** stdin as it came. */
export function inputRaw(): string {
  if (inputText === undefined) inputText = readFileSync(0, "utf8");
  return inputText;
}

/** The run's input: { guild, actor, eventName, event, batch, params, state }. */
export function input(): Input {
  return JSON.parse(inputRaw()) as Input;
}

let buffer = new Uint8Array(64 * 1024);

/** Sends one request as JSON text and returns the answer's JSON text ({ value } or { error }). */
export function callRaw(request: string): string {
  let n = secretaryCall(request, buffer);
  if (n < 0) {
    buffer = new Uint8Array(-n);
    n = secretaryCall(request, buffer);
  }
  return new TextDecoder().decode(buffer.subarray(0, n));
}

interface Answer {
  value?: unknown;
  error?: string;
}

/** Sends { fn, ...args } and returns its value; throws HostError when the host refuses. */
export function call(request: Record<string, unknown>): unknown {
  const answer = JSON.parse(callRaw(JSON.stringify(request))) as Answer;
  if (answer.error !== undefined) throw new HostError(answer.error);
  return answer.value;
}

/** GET a Discord route the rule's owner may read. query is like { limit: 1 }. */
export function get(route: string, query?: Record<string, unknown>): unknown {
  return query === undefined ? call({ fn: "get", route }) : call({ fn: "get", route, query });
}

/** Writes the result to stdout. Call it once, at the end. */
export function output(result: Output): void {
  secretaryOutput(JSON.stringify(result));
}
