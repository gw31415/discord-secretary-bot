import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import type { SKRSContext2D } from "@napi-rs/canvas";
import { MAX_CANVAS_SIDE, MAX_CANVAS_OPS, MAX_STRING, METHODS, PROPS } from "./canvas-prelude.ts";

// Replays what the sandbox's createCanvas() recorded (canvas-prelude.ts) on a
// real canvas. Loaded on the first drawing, since the native library is large.

// Fonts the code names come first; these follow so Japanese and emoji still have
// glyphs (skia falls back along the family list, not to the whole system).
const FALLBACK_FAMILIES = ["Noto Sans CJK JP", "IPAGothic", "Noto Color Emoji"];
let fallback: string | null = null;

function withFallback(font: string): string {
  fallback ??= FALLBACK_FAMILIES.filter((f) => GlobalFonts.has(f)).map((f) => `"${f}"`).join(", ");
  return fallback ? `${font.slice(0, 200)}, ${fallback}` : font.slice(0, 200);
}

function plain(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= MAX_STRING;
  return typeof value === "boolean";
}

/** Replays recorded drawing on a real canvas; throws with a reason the model can act on. */
export function renderCanvas(width: unknown, height: unknown, ops: unknown): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || (width as number) < 1 || (height as number) < 1 || (width as number) > MAX_CANVAS_SIDE || (height as number) > MAX_CANVAS_SIDE) {
    throw new Error(`canvas の大きさは 1〜${MAX_CANVAS_SIDE} の整数で指定してください`);
  }
  if (!Array.isArray(ops) || ops.length > MAX_CANVAS_OPS) throw new Error("描画の記録が読めません");
  const canvas = createCanvas(width as number, height as number);
  const ctx = canvas.getContext("2d") as unknown as Record<string, unknown> & SKRSContext2D;
  const methods = new Set<string>(METHODS);
  for (const [i, op] of ops.entries()) {
    if (!Array.isArray(op) || typeof op[0] !== "string") throw new Error(`描画の命令 ${i} が読めません`);
    const [name, ...args] = op as [string, ...unknown[]];
    if (name === "=") {
      const [prop, value] = args;
      if (typeof prop !== "string" || !Object.hasOwn(PROPS, prop) || !plain(value)) throw new Error(`${String(prop)} には数値か文字列を入れてください`);
      ctx[prop] = prop === "font" ? withFallback(String(value)) : value;
      continue;
    }
    if (!methods.has(name)) throw new Error(`${name} は使えません`);
    if (name === "setLineDash") {
      const dash = args[0];
      if (!Array.isArray(dash) || dash.length > 32 || !dash.every((d) => typeof d === "number" && Number.isFinite(d))) throw new Error("setLineDash には数値の配列を渡してください");
      ctx.setLineDash(dash as number[]);
      continue;
    }
    if (args.length > 8 || !args.every(plain)) throw new Error(`${name} の引数は数値か文字列だけです`);
    (ctx[name] as (...a: unknown[]) => void)(...args);
  }
  return canvas.toBuffer("image/png");
}

/** Text width and height for layout, measured with the same fonts the replay uses. */
export function measureText(font: string, text: string): Record<string, number> {
  const ctx = createCanvas(1, 1).getContext("2d");
  ctx.font = withFallback(font);
  const m = ctx.measureText(text.slice(0, MAX_STRING));
  return {
    width: m.width,
    actualBoundingBoxLeft: m.actualBoundingBoxLeft,
    actualBoundingBoxRight: m.actualBoundingBoxRight,
    actualBoundingBoxAscent: m.actualBoundingBoxAscent,
    actualBoundingBoxDescent: m.actualBoundingBoxDescent,
    fontBoundingBoxAscent: m.fontBoundingBoxAscent,
    fontBoundingBoxDescent: m.fontBoundingBoxDescent,
  };
}
