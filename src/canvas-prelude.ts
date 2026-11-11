// Drawing for sandboxed code. Inside QuickJS, createCanvas() returns a canvas
// whose 2D context only records what is drawn; attachImage() hands the record
// to the host, which replays it on a real canvas and makes a PNG. Only the
// methods and properties listed here exist, arguments must be plain numbers,
// strings or booleans, and nothing can load an image, a file or a URL.
// This file has no native code; the replay (canvas.ts) loads skia on first use.

export const MAX_CANVAS_SIDE = 2048;
export const MAX_CANVAS_OPS = 50_000;
export const MAX_IMAGES_PER_RUN = 4;
export const MAX_STRING = 2_000;

export const METHODS = [
  "fillRect", "strokeRect", "clearRect",
  "beginPath", "closePath", "moveTo", "lineTo", "arc", "arcTo", "ellipse", "rect", "roundRect",
  "quadraticCurveTo", "bezierCurveTo", "fill", "stroke", "clip",
  "fillText", "strokeText",
  "save", "restore", "translate", "rotate", "scale", "transform", "setTransform", "resetTransform",
  "setLineDash",
] as const;

export const PROPS: Record<string, string | number | boolean> = {
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
