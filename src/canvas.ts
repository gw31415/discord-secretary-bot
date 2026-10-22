import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import type { SKRSContext2D } from "@napi-rs/canvas";

// Drawing for sandboxed code. Inside QuickJS, createCanvas() returns a canvas
// whose 2D context only records what is drawn; attachImage() hands the record
// to the host, which replays it on a real canvas and makes a PNG. Only the
// methods and properties listed here exist, arguments must be plain numbers,
// strings or booleans, and nothing can load an image, a file or a URL.

export const MAX_CANVAS_SIDE = 2048;
export const MAX_CANVAS_OPS = 50_000;
export const MAX_IMAGES_PER_RUN = 4;
const MAX_STRING = 2_000;

const METHODS = [
  "fillRect", "strokeRect", "clearRect",
  "beginPath", "closePath", "moveTo", "lineTo", "arc", "arcTo", "ellipse", "rect", "roundRect",
  "quadraticCurveTo", "bezierCurveTo", "fill", "stroke", "clip",
  "fillText", "strokeText",
  "save", "restore", "translate", "rotate", "scale", "transform", "setTransform", "resetTransform",
  "setLineDash",
] as const;

const PROPS: Record<string, string | number | boolean> = {
  fillStyle: "#000000",
  strokeStyle: "#000000",
  lineWidth: 1,
  lineCap: "butt",
  lineJoin: "miter",
  miterLimit: 10,
  lineDashOffset: 0,
  font: "10px sans-serif",
  textAlign: "start",
  textBaseline: "alphabetic",
  direction: "inherit",
  globalAlpha: 1,
  globalCompositeOperation: "source-over",
  shadowBlur: 0,
  shadowColor: "rgba(0, 0, 0, 0)",
  shadowOffsetX: 0,
  shadowOffsetY: 0,
  imageSmoothingEnabled: true,
};

// Fonts the code names come first; these follow so Japanese and emoji still have
// glyphs (skia falls back along the family list, not to the whole system).
const FALLBACK_FAMILIES = ["Noto Sans CJK JP", "IPAGothic", "Noto Color Emoji"];
let fallback: string | null = null;

function withFallback(font: string): string {
  fallback ??= FALLBACK_FAMILIES.filter((f) => GlobalFonts.has(f)).map((f) => `"${f}"`).join(", ");
  return fallback ? `${font.slice(0, 200)}, ${fallback}` : font.slice(0, 200);
}

/** Defines createCanvas() and attachImage() inside the sandbox; __attach and __measure are host functions. */
export const CANVAS_PRELUDE = `
var __canvasMethods = ${JSON.stringify(METHODS)};
var __canvasProps = ${JSON.stringify(PROPS)};
function createCanvas(width, height) {
  var ops = [];
  var state = {};
  var saved = [];
  var push = function (op) {
    if (ops.length >= ${MAX_CANVAS_OPS}) throw new Error("描画の命令は1枚${MAX_CANVAS_OPS}個までです");
    ops.push(op);
  };
  var ctx = {};
  __canvasMethods.forEach(function (name) {
    ctx[name] = function () {
      var args = Array.prototype.slice.call(arguments);
      if (name === "save") saved.push(Object.assign({}, state));
      if (name === "restore" && saved.length > 0) state = saved.pop();
      push([name].concat(name === "setLineDash" ? [Array.prototype.slice.call(args[0] || [])] : args));
    };
  });
  Object.keys(__canvasProps).forEach(function (name) {
    Object.defineProperty(ctx, name, {
      get: function () { return name in state ? state[name] : __canvasProps[name]; },
      set: function (value) { state[name] = value; push(["=", name, value]); },
    });
  });
  ctx.measureText = function (text) { return __measure(String(ctx.font), String(text)); };
  var canvas = { width: width, height: height, __ops: ops, getContext: function (kind) {
    if (kind !== "2d") throw new Error("getContext は \\"2d\\" だけ使えます");
    return ctx;
  } };
  ctx.canvas = canvas;
  return canvas;
}
function attachImage(canvas, name) {
  if (!canvas || !canvas.__ops) throw new Error("attachImage には createCanvas() の canvas を渡してください");
  return __attach(canvas.width, canvas.height, JSON.stringify(canvas.__ops), name === undefined ? "" : String(name));
}
`;

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
