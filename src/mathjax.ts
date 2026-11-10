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

// MathJax for media.ts, in its own module so it loads only when a formula is drawn.
// Only the TeX packages imported above exist, so \require, \href and the like are unknown macros.

let doc: ReturnType<typeof mathjax.document> | null = null;
export const adaptor = liteAdaptor();

/** The one MathJax document, made on first use. */
export function mathDocument() {
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

