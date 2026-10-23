import { randomFillSync } from "node:crypto";
import { parentPort, receiveMessageOnPort } from "node:worker_threads";
import type { MessagePort } from "node:worker_threads";

// Runs Wasm modules, one at a time, in a thread of its own; each run gets a
// fresh instance, so runs share nothing but the thread. The module sees a minimal WASI
// preview 1: stdin holds the input, stdout and stderr are collected, clocks and
// random numbers work, and every file, socket or other call answers that it is
// not there. secretary.call sends a JSON request to the main thread and blocks
// on Atomics.wait until the answer arrives, so to the module it is an ordinary
// synchronous function. The main thread kills this thread when time runs out.

export interface WorkerInput {
  module: WebAssembly.Module;
  stdin: Uint8Array;
  port: MessagePort;
  /** One Int32: the main thread sets it to 1 when an answer is waiting. */
  signal: SharedArrayBuffer;
  maxStdout: number;
  maxStderr: number;
}

export type WorkerMessage =
  | { type: "call"; request: string }
  | { type: "done"; exitCode: number; stdout: Uint8Array; stderr: Uint8Array; error?: string };

const ERRNO = { SUCCESS: 0, BADF: 8, INVAL: 28, NOSYS: 52 } as const;

class Exit extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

class Output {
  readonly #chunks: Uint8Array[] = [];
  #size = 0;
  readonly #max: number;
  readonly #label: string;
  readonly #truncate: boolean;
  constructor(max: number, label: string, truncate: boolean) {
    this.#max = max;
    this.#label = label;
    this.#truncate = truncate;
  }
  write(data: Uint8Array): void {
    if (this.#size + data.length > this.#max) {
      if (!this.#truncate) throw new Error(`${this.#label}は${this.#max}バイトまでです`);
      data = data.subarray(0, Math.max(0, this.#max - this.#size));
    }
    this.#chunks.push(data.slice());
    this.#size += data.length;
  }
  bytes(): Uint8Array {
    return Buffer.concat(this.#chunks);
  }
}

function run(input: WorkerInput): WorkerMessage {
  const { module, stdin, port } = input;
  const flag = new Int32Array(input.signal);
  const stdout = new Output(input.maxStdout, "標準出力", false);
  const stderr = new Output(input.maxStderr, "標準エラー出力", true);
  let stdinPos = 0;
  let memory: WebAssembly.Memory | undefined;
  const view = () => new DataView(memory!.buffer);
  const bytesAt = (ptr: number, len: number) => new Uint8Array(memory!.buffer, ptr, len);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  // The answer to the last request, kept so a retry with a bigger buffer does not ask twice.
  let last: { request: string; response: Uint8Array } | null = null;
  const ask = (request: string): Uint8Array => {
    if (last?.request === request) return last.response;
    Atomics.store(flag, 0, 0);
    port.postMessage({ type: "call", request } satisfies WorkerMessage);
    for (;;) {
      Atomics.wait(flag, 0, 0, 1000);
      const got = receiveMessageOnPort(port);
      if (got) {
        Atomics.store(flag, 0, 0);
        const response = encoder.encode((got.message as { response: string }).response);
        last = { request, response };
        return response;
      }
    }
  };

  const iovecs = (iovs: number, count: number): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    const dv = view();
    for (let i = 0; i < count; i++) out.push([dv.getUint32(iovs + i * 8, true), dv.getUint32(iovs + i * 8 + 4, true)]);
    return out;
  };

  const wasi: Record<string, (...args: any[]) => number | void> = {
    args_sizes_get(argc: number, bufSize: number) {
      view().setUint32(argc, 1, true);
      view().setUint32(bufSize, 7, true);
      return ERRNO.SUCCESS;
    },
    args_get(argv: number, buf: number) {
      view().setUint32(argv, buf, true);
      bytesAt(buf, 7).set(encoder.encode("module\0"));
      return ERRNO.SUCCESS;
    },
    environ_sizes_get(count: number, size: number) {
      view().setUint32(count, 0, true);
      view().setUint32(size, 0, true);
      return ERRNO.SUCCESS;
    },
    environ_get() {
      return ERRNO.SUCCESS;
    },
    clock_res_get(_id: number, out: number) {
      view().setBigUint64(out, 1000n, true);
      return ERRNO.SUCCESS;
    },
    clock_time_get(id: number, _precision: bigint, out: number) {
      const ns = id === 0 ? BigInt(Date.now()) * 1_000_000n : process.hrtime.bigint();
      view().setBigUint64(out, ns, true);
      return ERRNO.SUCCESS;
    },
    random_get(buf: number, len: number) {
      randomFillSync(bytesAt(buf, len));
      return ERRNO.SUCCESS;
    },
    fd_write(fd: number, iovs: number, count: number, written: number) {
      if (fd !== 1 && fd !== 2) return ERRNO.BADF;
      let total = 0;
      for (const [ptr, len] of iovecs(iovs, count)) {
        (fd === 1 ? stdout : stderr).write(bytesAt(ptr, len));
        total += len;
      }
      view().setUint32(written, total, true);
      return ERRNO.SUCCESS;
    },
    fd_read(fd: number, iovs: number, count: number, read: number) {
      if (fd !== 0) return ERRNO.BADF;
      let total = 0;
      for (const [ptr, len] of iovecs(iovs, count)) {
        const n = Math.min(len, stdin.length - stdinPos);
        bytesAt(ptr, n).set(stdin.subarray(stdinPos, stdinPos + n));
        stdinPos += n;
        total += n;
        if (n < len) break;
      }
      view().setUint32(read, total, true);
      return ERRNO.SUCCESS;
    },
    fd_fdstat_get(fd: number, out: number) {
      if (fd > 2) return ERRNO.BADF;
      const dv = view();
      dv.setUint8(out, 2); // character device
      dv.setUint16(out + 2, 0, true);
      dv.setBigUint64(out + 8, fd === 0 ? 2n : 64n, true); // fd_read / fd_write
      dv.setBigUint64(out + 16, 0n, true);
      return ERRNO.SUCCESS;
    },
    fd_fdstat_set_flags(fd: number) {
      return fd > 2 ? ERRNO.BADF : ERRNO.SUCCESS;
    },
    fd_filestat_get(fd: number, out: number) {
      if (fd > 2) return ERRNO.BADF;
      bytesAt(out, 64).fill(0);
      view().setUint8(out + 16, 2);
      return ERRNO.SUCCESS;
    },
    fd_prestat_get() {
      return ERRNO.BADF; // no preopened directories
    },
    fd_close(fd: number) {
      return fd > 2 ? ERRNO.BADF : ERRNO.SUCCESS;
    },
    fd_seek(fd: number) {
      return fd > 2 ? ERRNO.BADF : 70; // ESPIPE
    },
    fd_sync() {
      return ERRNO.SUCCESS;
    },
    sched_yield() {
      return ERRNO.SUCCESS;
    },
    proc_exit(code: number) {
      throw new Exit(code);
    },
    proc_raise() {
      throw new Exit(134);
    },
  };

  const imports: WebAssembly.Imports = { wasi_snapshot_preview1: {}, secretary: {} };
  for (const i of WebAssembly.Module.imports(module)) {
    if (i.module === "wasi_snapshot_preview1") imports.wasi_snapshot_preview1![i.name] = wasi[i.name] ?? (() => ERRNO.NOSYS);
  }
  imports.secretary!.call = (reqPtr: number, reqLen: number, respPtr: number, respCap: number): number => {
    const request = decoder.decode(bytesAt(reqPtr, reqLen));
    const response = ask(request);
    if (response.length > respCap) return -response.length;
    bytesAt(respPtr, response.length).set(response);
    last = null;
    return response.length;
  };

  let exitCode = 0;
  let error: string | undefined;
  try {
    const instance = new WebAssembly.Instance(module, imports);
    memory = instance.exports.memory as WebAssembly.Memory;
    (instance.exports._start as () => void)();
  } catch (e) {
    if (e instanceof Exit) exitCode = e.code;
    else {
      exitCode = 1;
      error = e instanceof WebAssembly.RuntimeError ? `Wasmの実行時エラー: ${e.message}` : e instanceof Error ? e.message : String(e);
    }
  }
  return { type: "done", exitCode, stdout: stdout.bytes(), stderr: stderr.bytes(), ...(error ? { error } : {}) };
}

parentPort!.on("message", (input: WorkerInput) => {
  input.port.postMessage(run(input));
});
