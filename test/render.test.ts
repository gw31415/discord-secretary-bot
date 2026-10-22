import { test } from "node:test";
import assert from "node:assert/strict";
import { renderImage, svgProblem } from "../src/render.ts";
import { ImageBox, imageTool } from "../src/agent/attachments.ts";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

test("TeX renders to a padded PNG, and mistakes come back as errors", () => {
  const image = renderImage({ tex: String.raw`\int_0^1 x^2\,dx = \frac{1}{3}` });
  assert.ok(image.png.subarray(0, 4).equals(PNG_MAGIC));
  assert.ok(image.width > image.height && image.height > 48);
  assert.throws(() => renderImage({ tex: String.raw`\frac{1` }), /TeXの誤り/);
  assert.throws(() => renderImage({ tex: String.raw`\nosuchcommand` }), /Undefined control sequence/);
  // Packages that load more code are left out.
  assert.throws(() => renderImage({ tex: String.raw`\require{physics}` }), /TeXの誤り/);
});

test("SVG may only point at itself or inline images", () => {
  const ok = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><defs><linearGradient id="g"/></defs><rect width="40" height="20" fill="url(#g)"/><use href="#g"/></svg>`;
  assert.equal(svgProblem(ok), null);
  assert.ok(renderImage({ svg: ok }).png.subarray(0, 4).equals(PNG_MAGIC));
  for (const bad of [
    `<svg xmlns="http://www.w3.org/2000/svg"><image href="/etc/hostname" width="9" height="9"/></svg>`,
    `<svg xmlns="http://www.w3.org/2000/svg"><image xlink:href='file:///etc/passwd'/></svg>`,
    `<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/a.png"/></svg>`,
    `<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(https://example.com/x.css);</style></svg>`,
    `<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(https://example.com/x)"/></svg>`,
    `<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>`,
    `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`,
  ]) assert.notEqual(svgProblem(bad), null, bad);
  assert.throws(() => renderImage({ svg: `<svg xmlns="http://www.w3.org/2000/svg" width="5000" height="10"/>` }), /4096px/);
  assert.throws(() => renderImage({}), /どちらか1つ/);
});

test("the image tool numbers images, and a change can take some of them off the reply", async () => {
  const box = new ImageBox();
  const tool = imageTool(box, true);
  const first = await tool.execute("c1", { tex: "x^2", name: "square" });
  assert.match((first.content[0] as { text: string }).text, /画像 img1\(square\.png/);
  assert.equal(first.content[1]!.type, "image");
  await tool.execute("c2", { tex: "y" });
  assert.deepEqual(Object.values(box.all()).map((a) => a.name), ["square.png", "img2.png"]);
  box.take(["img1"]);
  assert.deepEqual(box.forReply().map((a) => a.name), ["img2.png"]);
  const blind = await imageTool(new ImageBox(), false).execute("c3", { tex: "z" });
  assert.equal(blind.content.length, 1);
});
