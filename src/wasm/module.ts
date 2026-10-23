import { createHash } from "node:crypto";

// Checks an uploaded Wasm module before anything runs it, and caps its memory.
// A module is a WASI preview 1 command: it exports `_start` and `memory`, and
// imports only WASI functions and `secretary.call`. Its memory maximum is
// rewritten to MAX_MEMORY_PAGES, so no build can grow past it; the rest of the
// binary is kept byte for byte.

export const MAX_MODULE_BYTES = 8 * 1024 * 1024;
/** 64 KiB pages: 1024 = 64 MiB. */
export const MAX_MEMORY_PAGES = 1024;
export const WASI_MODULE = "wasi_snapshot_preview1";
export const HOST_MODULE = "secretary";
export const HOST_FUNCTIONS = new Set(["call"]);

export interface ModuleInfo {
  sha256: string;
  size: number;
  /** Tools and languages the module says built it (its "producers" section). */
  producers: string[];
  imports: string[];
  /** Pages the memory starts with and the maximum after capping. */
  memory: { min: number; max: number };
}

export class ModuleRejected extends Error {}

/** Checks the module and returns the bytes to keep (memory capped) and what it is. */
export async function prepareModule(bytes: Uint8Array): Promise<{ bytes: Buffer; info: ModuleInfo }> {
  if (bytes.length > MAX_MODULE_BYTES) throw new ModuleRejected(`モジュールは${MAX_MODULE_BYTES / 1024 / 1024}MBまでです`);
  if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) throw new ModuleRejected("Wasmのバイナリではありません(.wasm を選んでください)");
  if (bytes[4] !== 1 || bytes[5] !== 0 || bytes[6] !== 0 || bytes[7] !== 0) throw new ModuleRejected("コアWasmモジュール(バージョン1)だけ扱えます。コンポーネントは使えません");
  const { patched, memory, producers } = rewrite(bytes);
  let module: WebAssembly.Module;
  try {
    module = await WebAssembly.compile(patched);
  } catch (e) {
    throw new ModuleRejected(`Wasmとして読めません: ${e instanceof Error ? e.message : String(e)}`);
  }
  const imports = WebAssembly.Module.imports(module);
  const problems: string[] = [];
  for (const i of imports) {
    const ok = i.kind === "function" && (i.module === WASI_MODULE || (i.module === HOST_MODULE && HOST_FUNCTIONS.has(i.name)));
    if (!ok) problems.push(`${i.module}.${i.name}(${i.kind})`);
  }
  if (problems.length) throw new ModuleRejected(`使えない import があります: ${problems.slice(0, 5).join("、")}。使えるのは ${WASI_MODULE} の関数と ${HOST_MODULE}.call だけです`);
  const exports = WebAssembly.Module.exports(module);
  if (!exports.some((e) => e.name === "_start" && e.kind === "function")) throw new ModuleRejected("_start がありません。WASI のコマンド(main を持つプログラム)としてビルドしてください");
  if (!exports.some((e) => e.name === "memory" && e.kind === "memory")) throw new ModuleRejected("memory を export していません");
  if (!memory) throw new ModuleRejected("メモリを定義していません");
  const out = Buffer.from(patched);
  return {
    bytes: out,
    info: {
      sha256: createHash("sha256").update(out).digest("hex"),
      size: out.length,
      producers,
      imports: imports.map((i) => `${i.module}.${i.name}`),
      memory,
    },
  };
}

function readU32(bytes: Uint8Array, pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  for (;;) {
    if (pos >= bytes.length) throw new ModuleRejected("Wasmのバイナリが途中で切れています");
    const b = bytes[pos++]!;
    result += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) return [result, pos];
    shift += 7;
    if (shift > 35) throw new ModuleRejected("Wasmのバイナリが壊れています");
  }
}

function writeU32(n: number): number[] {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n = Math.floor(n / 128);
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
}

function readName(bytes: Uint8Array, pos: number): [string, number] {
  const [len, start] = readU32(bytes, pos);
  return [new TextDecoder().decode(bytes.subarray(start, start + len)), start + len];
}

/** Rewrites the memory section's limits and reads the producers section. */
function rewrite(bytes: Uint8Array): { patched: Uint8Array; memory: { min: number; max: number } | null; producers: string[] } {
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  let memory: { min: number; max: number } | null = null;
  const producers: string[] = [];
  let pos = 8;
  while (pos < bytes.length) {
    const id = bytes[pos]!;
    const [size, start] = readU32(bytes, pos + 1);
    const end = start + size;
    if (end > bytes.length) throw new ModuleRejected("Wasmのバイナリが途中で切れています");
    if (id === 5) {
      const [count, p0] = readU32(bytes, start);
      if (count > 1) throw new ModuleRejected("メモリは1つだけにしてください");
      const body: number[] = [...writeU32(count)];
      let p = p0;
      for (let i = 0; i < count; i++) {
        const flags = bytes[p++]!;
        if (flags & 0x02) throw new ModuleRejected("共有メモリ(スレッド)は使えません");
        if (flags & 0x04) throw new ModuleRejected("memory64 は使えません");
        let min: number;
        [min, p] = readU32(bytes, p);
        let max = MAX_MEMORY_PAGES;
        if (flags & 0x01) {
          let declared: number;
          [declared, p] = readU32(bytes, p);
          max = Math.min(declared, MAX_MEMORY_PAGES);
        }
        if (min > MAX_MEMORY_PAGES) throw new ModuleRejected(`メモリの初期サイズが上限(${MAX_MEMORY_PAGES / 16}MiB)を超えています`);
        memory = { min, max };
        body.push(0x01, ...writeU32(min), ...writeU32(max));
      }
      if (p !== end) throw new ModuleRejected("メモリのセクションが壊れています");
      parts.push(Uint8Array.of(5, ...writeU32(body.length), ...body));
    } else {
      if (id === 0) {
        try {
          const [name, p] = readName(bytes, start);
          if (name === "producers") producers.push(...readProducers(bytes, p, end));
        } catch {
          // An unreadable custom section only loses the display.
        }
      }
      parts.push(bytes.subarray(pos, end));
    }
    pos = end;
  }
  return { patched: Buffer.concat(parts), memory, producers };
}

function readProducers(bytes: Uint8Array, pos: number, end: number): string[] {
  const out: string[] = [];
  let [fields, p] = readU32(bytes, pos);
  for (let f = 0; f < fields && p < end; f++) {
    let field: string;
    [field, p] = readName(bytes, p);
    let values: number;
    [values, p] = readU32(bytes, p);
    for (let v = 0; v < values && p < end; v++) {
      let name: string;
      let version: string;
      [name, p] = readName(bytes, p);
      [version, p] = readName(bytes, p);
      if (field === "language" || field === "processed-by") out.push(`${name}${version ? ` ${version}` : ""}`.slice(0, 80));
    }
  }
  return out.slice(0, 8);
}
