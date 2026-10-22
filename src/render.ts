import { Resvg } from "@resvg/resvg-js";
import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import { AllPackages } from "mathjax-full/js/input/tex/AllPackages.js";

// Draws images for the bot to post: TeX through MathJax, or SVG the model wrote,
// rasterized to PNG by resvg. Nothing here touches the network or the disk: SVG
// may only point at its own elements or inline images.

export interface ImageSource {
  tex?: string;
  svg?: string;
}

export interface RenderedImage {
  png: Buffer;
  width: number;
  height: number;
}

const MAX_TEX = 4_000;
const MAX_SVG = 200_000;
const MAX_SIDE = 4_096;
const MAX_PNG_BYTES = 4 * 1024 * 1024;
/** MathJax measures in ex; one ex at this size reads well in Discord. */
const PX_PER_EX = 18;
const TEX_PADDING_PX = 24;

// The TeX packages that read files or define commands on the fly stay out.
const TEX_PACKAGES = AllPackages.filter((p) => !["require", "autoload", "setoptions", "html", "noundefined", "noerrors"].includes(p));

let texDocument: ReturnType<typeof mathjax.document> | null = null;
const adaptor = liteAdaptor();

function texToSvg(tex: string): string {
  if (!texDocument) {
    RegisterHTMLHandler(adaptor);
    texDocument = mathjax.document("", {
      InputJax: new TeX({ packages: TEX_PACKAGES, formatError: (_jax: unknown, err: Error) => { throw new Error(`TeXの誤り: ${err.message}`); } }),
      OutputJax: new SVG({ fontCache: "none" }),
    });
  }
  const node = texDocument.convert(tex, { display: true });
  const svg = adaptor.innerHTML(node);
  const error = /data-mjx-error="([^"]*)"/.exec(svg);
  if (error) throw new Error(`TeXの誤り: ${error[1]}`);
  return padTexSvg(svg);
}

/** MathJax sizes its SVG in ex and leaves no margin; this gives it pixels and some room. */
function padTexSvg(svg: string): string {
  const open = /^<svg\b[^>]*>/.exec(svg)?.[0];
  const viewBox = open && /viewBox="([-\d.]+) ([-\d.]+) ([\d.]+) ([\d.]+)"/.exec(open);
  const width = open && /width="([\d.]+)ex"/.exec(open);
  const height = open && /height="([\d.]+)ex"/.exec(open);
  if (!open || !viewBox || !width || !height) return svg;
  const [x, y, w, h] = viewBox.slice(1).map(Number) as [number, number, number, number];
  const pxW = Number(width[1]) * PX_PER_EX;
  const pxH = Number(height[1]) * PX_PER_EX;
  const unitsPerPx = w / pxW;
  const pad = TEX_PADDING_PX * unitsPerPx;
  const head = `<svg xmlns="http://www.w3.org/2000/svg" width="${(pxW + TEX_PADDING_PX * 2).toFixed(1)}" height="${(pxH + TEX_PADDING_PX * 2).toFixed(1)}" viewBox="${x - pad} ${y - pad} ${w + pad * 2} ${h + pad * 2}" color="black">`;
  return head + svg.slice(open.length);
}

/**
 * Rejects SVG that could reach outside itself. resvg runs no scripts, but it
 * would follow an href to a file; only "#id" and inline data images are left.
 */
export function svgProblem(svg: string): string | null {
  if (svg.length > MAX_SVG) return `SVGは${MAX_SVG}文字までです`;
  if (!/<svg\b/i.test(svg)) return "<svg> 要素がありません";
  if (/<!ENTITY|<!DOCTYPE/i.test(svg)) return "DOCTYPE・ENTITY は使えません";
  if (/<\s*(script|foreignObject)\b/i.test(svg)) return "script・foreignObject は使えません";
  if (/@import|url\(\s*['"]?(?!#)/i.test(svg)) return "外部を参照する CSS は使えません(url(#id) のみ使えます)";
  for (const m of svg.matchAll(/\b(?:xlink:)?(?:href|src)\s*=\s*(["'])(.*?)\1/gis)) {
    const target = m[2]!.trim();
    if (!target.startsWith("#") && !/^data:image\/(png|jpeg|gif|webp);base64,/i.test(target)) return `参照できるのは #id とインラインの画像だけです: ${target.slice(0, 60)}`;
  }
  return null;
}

/** Draws one image; throws with a reason the model can act on. */
export function renderImage(source: ImageSource): RenderedImage {
  if ((source.tex === undefined) === (source.svg === undefined)) throw new Error("tex か svg のどちらか1つを指定してください");
  let svg: string;
  let background: string | undefined;
  if (source.tex !== undefined) {
    if (!source.tex.trim()) throw new Error("TeXが空です");
    if (source.tex.length > MAX_TEX) throw new Error(`TeXは${MAX_TEX}文字までです`);
    svg = texToSvg(source.tex);
    background = "white";
  } else {
    const problem = svgProblem(source.svg!);
    if (problem) throw new Error(problem);
    svg = source.svg!;
  }
  let resvg: Resvg;
  try {
    resvg = new Resvg(svg, { ...(background ? { background } : {}), font: { loadSystemFonts: true } });
  } catch (e) {
    throw new Error(`SVGを読めません: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (resvg.width < 1 || resvg.height < 1) throw new Error("画像の大きさが0です(width・height か viewBox を指定してください)");
  if (resvg.width > MAX_SIDE || resvg.height > MAX_SIDE) throw new Error(`画像は縦横${MAX_SIDE}px までです(今は ${Math.round(resvg.width)}×${Math.round(resvg.height)})`);
  const rendered = resvg.render();
  const png = rendered.asPng();
  if (png.length > MAX_PNG_BYTES) throw new Error("画像が大きすぎます(PNGで4MBまで)");
  return { png, width: rendered.width, height: rendered.height };
}
