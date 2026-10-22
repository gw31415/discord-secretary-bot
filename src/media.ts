import sharp from "sharp";
import type { Metadata } from "sharp";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { mathjax } from "@mathjax/src/js/mathjax.js";
import { TeX } from "@mathjax/src/js/input/tex.js";
import { SVG } from "@mathjax/src/js/output/svg.js";
import { liteAdaptor } from "@mathjax/src/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "@mathjax/src/js/handlers/html.js";
import "@mathjax/src/js/input/tex/base/BaseConfiguration.js";
import "@mathjax/src/js/input/tex/ams/AmsConfiguration.js";
import "@mathjax/src/js/input/tex/newcommand/NewcommandConfiguration.js";
import "@mathjax/src/js/input/tex/boldsymbol/BoldsymbolConfiguration.js";
import "@mathjax/src/js/input/tex/color/ColorConfiguration.js";
import "@mathjax/src/js/input/tex/cancel/CancelConfiguration.js";
import "@mathjax/src/js/input/tex/mhchem/MhchemConfiguration.js";
import "@mathjax/src/js/util/asyncLoad/esm.js";
import { MathJaxNewcmFont } from "@mathjax/mathjax-newcm-font/js/svg.js";
import { MathJaxMhchemFontExtension } from "@mathjax/mathjax-mhchem-font-extension/js/svg.js";

// Image work for the agent and its sandboxed code: TeX drawn with MathJax, and
// conversions (size, crop, format) with sharp. Everything works on bytes in
// memory; nothing here reads a file or a URL. Only the TeX packages imported
// above exist, so \require, \href and the like are unknown macros.

export const MAX_TEX = 2_000;
export const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
export const MAX_OUTPUT_SIDE = 4096;
/** Longest side of an image the model looks at; larger ones cost tokens and time without helping. */
export const MODEL_IMAGE_SIDE = 1568;
const MODEL_IMAGE_BYTES = 1024 * 1024;
/** Decoding stops past this, so a tiny file cannot unpack into gigabytes. */
const MAX_INPUT_PIXELS = 50_000_000;

const COLOR = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{1,20}|rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(,\s*[\d.]+\s*)?\))$/;

let doc: ReturnType<typeof mathjax.document> | null = null;
const adaptor = liteAdaptor();

function mathDocument() {
  if (doc) return doc;
  RegisterHTMLHandler(adaptor);
  // \ce arrows come from their own glyphs.
  MathJaxNewcmFont.addExtension(MathJaxMhchemFontExtension);
  const tex = new TeX({
    packages: ["base", "ams", "newcommand", "boldsymbol", "color", "cancel", "mhchem"],
    // A mistake in the TeX comes back as an error the model can fix, not as red text in the picture.
    formatError: (_jax: unknown, err: Error) => {
      throw err;
    },
  });
  doc = mathjax.document("", { InputJax: tex, OutputJax: new SVG({ fontCache: "none", fontData: MathJaxNewcmFont }) });
  return doc;
}

export interface MathOptions {
  /** Display style (centered, large operators) instead of inline. */
  display?: boolean;
  /** Font size in px. */
  size?: number;
  color?: string;
  /** Background colour; transparent when absent. */
  background?: string;
  /** Space around the formula in px. */
  padding?: number;
}

function color(value: string | undefined, what: string): string | undefined {
  if (value === undefined) return undefined;
  if (!COLOR.test(value.trim())) throw new Error(`${what} は #RRGGBB・色の名前・rgb() で指定してください`);
  return value.trim();
}

/** The formula as a PNG; throws with MathJax's message when the TeX is wrong. */
export async function renderMath(tex: string, options: MathOptions = {}): Promise<Buffer> {
  if (typeof tex !== "string" || tex.trim() === "") throw new Error("数式(TeX)が空です");
  if (tex.length > MAX_TEX) throw new Error(`数式は${MAX_TEX}文字までです`);
  const size = options.size ?? 32;
  if (!Number.isFinite(size) || size < 8 || size > 200) throw new Error("size は 8〜200 の数で指定してください");
  const padding = options.padding ?? Math.round(size / 4);
  if (!Number.isInteger(padding) || padding < 0 || padding > 200) throw new Error("padding は 0〜200 の整数で指定してください");
  const fg = color(options.color, "color") ?? "#000000";
  const bg = color(options.background, "background");

  let svg: string;
  try {
    const node = await mathDocument().convertPromise(tex, { display: options.display ?? true });
    svg = adaptor.innerHTML(node);
  } catch (e) {
    // TeX errors are TexError objects, not Error instances.
    const message = (e as { message?: unknown } | null)?.message;
    throw new Error(`数式を描けません: ${typeof message === "string" ? message : String(e)}`);
  }
  // MathJax sizes in ex; the viewBox is in thousandths of an em, so px follow from the font size.
  const box = /viewBox="([-\d.]+) ([-\d.]+) ([\d.]+) ([\d.]+)"/.exec(svg);
  if (!box) throw new Error("数式を描けません");
  const width = Math.max(1, Math.ceil((Number(box[3]) / 1000) * size));
  const height = Math.max(1, Math.ceil((Number(box[4]) / 1000) * size));
  if (width + 2 * padding > MAX_OUTPUT_SIDE || height + 2 * padding > MAX_OUTPUT_SIDE) throw new Error("数式が大きすぎます。size を小さくするか分けてください");
  svg = svg
    .replace(/ width="[^"]*"/, ` width="${width}"`)
    .replace(/ height="[^"]*"/, ` height="${height}"`)
    .replace(/ style="[^"]*"/, "")
    .replaceAll("currentColor", fg);

  const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
  let image = sharp(Buffer.from(svg), { limitInputPixels: MAX_INPUT_PIXELS }).extend({ top: padding, bottom: padding, left: padding, right: padding, background: transparent });
  if (bg) image = sharp(await image.png().toBuffer()).flatten({ background: bg });
  return image.png().toBuffer();
}

export const FORMATS = ["png", "jpeg", "webp"] as const;
export type Format = (typeof FORMATS)[number];
export const FITS = ["inside", "contain", "cover", "fill", "outside"] as const;

export interface ConvertOptions {
  /** Output format; the source's own (or PNG) when absent. */
  format?: Format;
  width?: number;
  height?: number;
  /** How width and height are met; "inside" keeps the whole image within them. */
  fit?: (typeof FITS)[number];
  /** Applied before resizing, in source pixels. */
  crop?: { left: number; top: number; width: number; height: number };
  /** Degrees clockwise, multiples of 90. */
  rotate?: number;
  /** Mirror top to bottom. */
  flip?: boolean;
  /** Mirror left to right. */
  flop?: boolean;
  grayscale?: boolean;
  /** Cut away borders of the same colour as the corner. */
  trim?: boolean;
  /** Fills transparency (and "contain" margins) with this colour. */
  background?: string;
  /** 1–100 for JPEG and WebP. */
  quality?: number;
}

function side(value: number | undefined, what: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > MAX_OUTPUT_SIDE) throw new Error(`${what} は 1〜${MAX_OUTPUT_SIDE} の整数で指定してください`);
  return value;
}

/** Converts an image; returns the bytes and the format they are in. */
export async function convertImage(source: Buffer, options: ConvertOptions = {}): Promise<{ data: Buffer; format: Format }> {
  if (source.length > MAX_SOURCE_BYTES) throw new Error("元の画像は20MBまでです");
  const width = side(options.width, "width");
  const height = side(options.height, "height");
  if (options.fit !== undefined && !FITS.includes(options.fit)) throw new Error(`fit は ${FITS.join("・")} のどれかです`);
  if (options.format !== undefined && !FORMATS.includes(options.format)) throw new Error(`format は ${FORMATS.join("・")} のどれかです`);
  if (options.rotate !== undefined && (!Number.isInteger(options.rotate) || options.rotate % 90 !== 0)) throw new Error("rotate は90の倍数で指定してください");
  if (options.quality !== undefined && (!Number.isInteger(options.quality) || options.quality < 1 || options.quality > 100)) throw new Error("quality は 1〜100 の整数で指定してください");
  const bg = color(options.background, "background");

  let image = sharp(source, { limitInputPixels: MAX_INPUT_PIXELS, animated: false }).rotate();
  let meta: Metadata;
  try {
    meta = await image.metadata();
  } catch {
    throw new Error("画像として読めません");
  }
  if (options.crop) {
    const { left, top, width: w, height: h } = options.crop;
    const ok = [left, top, w, h].every((v) => Number.isInteger(v) && v >= 0) && w > 0 && h > 0;
    if (!ok || left + w > (meta.autoOrient?.width ?? meta.width) || top + h > (meta.autoOrient?.height ?? meta.height)) throw new Error("crop が画像の外にはみ出しています");
    image = image.extract({ left, top, width: w, height: h });
  }
  if (options.trim) image = image.trim();
  if (options.rotate) image = image.rotate(options.rotate, bg ? { background: bg } : {});
  if (options.flip) image = image.flip();
  if (options.flop) image = image.flop();
  if (width || height) image = image.resize({ width, height, fit: options.fit ?? "inside", ...(bg ? { background: bg } : {}) });
  if (options.grayscale) image = image.grayscale();
  if (bg) image = image.flatten({ background: bg });

  const format: Format = options.format ?? (FORMATS.includes(meta.format as Format) ? (meta.format as Format) : "png");
  const quality = options.quality ?? 85;
  image = format === "jpeg" ? image.jpeg({ quality, mozjpeg: true }) : format === "webp" ? image.webp({ quality }) : image.png({ compressionLevel: 9 });
  const { data, info } = await image.toBuffer({ resolveWithObject: true });
  if (info.width > MAX_OUTPUT_SIDE || info.height > MAX_OUTPUT_SIDE) throw new Error(`出来上がりが${MAX_OUTPUT_SIDE}pxを超えます。width か height を指定してください`);
  return { data, format };
}

/**
 * An image made small enough for the model to look at: at most MODEL_IMAGE_SIDE
 * on the long side, re-encoded as WebP when that saves much. Small images and
 * anything sharp cannot read come back as they were.
 */
export async function forModel(data: Buffer, mimeType: string): Promise<{ data: Buffer; mimeType: string }> {
  try {
    const meta = await sharp(data, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    const long = Math.max(meta.autoOrient?.width ?? meta.width, meta.autoOrient?.height ?? meta.height);
    if (long <= MODEL_IMAGE_SIDE && data.length <= MODEL_IMAGE_BYTES) return { data, mimeType };
    const out = await sharp(data, { limitInputPixels: MAX_INPUT_PIXELS, animated: false })
      .rotate()
      .resize({ width: MODEL_IMAGE_SIDE, height: MODEL_IMAGE_SIDE, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer();
    return out.length < data.length ? { data: out, mimeType: "image/webp" } : { data, mimeType };
  } catch {
    return { data, mimeType };
  }
}

const ColorText = Type.String({ maxLength: 40, description: "#RRGGBB・色の名前・rgb()" });

export const MathOptionsSchema = Type.Object({
  display: Type.Optional(Type.Boolean({ description: "別行立て(既定 true)。false で文中の小さな形" })),
  size: Type.Optional(Type.Number({ minimum: 8, maximum: 200, description: "文字の大きさ(px、既定 32)" })),
  color: Type.Optional(ColorText),
  background: Type.Optional(ColorText),
  padding: Type.Optional(Type.Integer({ minimum: 0, maximum: 200, description: "周りの余白(px)" })),
}, { additionalProperties: false });

export const ConvertOptionsSchema = Type.Object({
  format: Type.Optional(Type.Union(FORMATS.map((f) => Type.Literal(f)))),
  width: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_OUTPUT_SIDE })),
  height: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_OUTPUT_SIDE })),
  fit: Type.Optional(Type.Union(FITS.map((f) => Type.Literal(f)), { description: "inside=収める(既定)、cover=切り抜いて埋める、contain=余白を足して収める、fill=引き伸ばす" })),
  crop: Type.Optional(Type.Object({ left: Type.Integer({ minimum: 0 }), top: Type.Integer({ minimum: 0 }), width: Type.Integer({ minimum: 1 }), height: Type.Integer({ minimum: 1 }) }, { description: "大きさを変える前に切り抜く範囲(元の画像のpx)" })),
  rotate: Type.Optional(Type.Integer({ description: "時計回りの角度(90の倍数)" })),
  flip: Type.Optional(Type.Boolean({ description: "上下反転" })),
  flop: Type.Optional(Type.Boolean({ description: "左右反転" })),
  grayscale: Type.Optional(Type.Boolean()),
  trim: Type.Optional(Type.Boolean({ description: "四隅と同じ色の余白を削る" })),
  background: Type.Optional(ColorText),
  quality: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "JPEG・WebP の画質(既定 85)" })),
}, { additionalProperties: false });

/** Options from sandboxed code, checked as strictly as the tools' parameters. */
export function parseOptions<S extends typeof MathOptionsSchema | typeof ConvertOptionsSchema>(schema: S, raw: unknown): Static<S> {
  const value = raw ?? {};
  if (!Value.Check(schema, value)) {
    const problems = [...Value.Errors(schema, value)].slice(0, 3).map((e) => `${e.instancePath || "/"} ${e.message}`);
    throw new Error(`オプションが正しくありません: ${problems.join("; ")}`);
  }
  return value as Static<S>;
}
