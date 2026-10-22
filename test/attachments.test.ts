import { test } from "node:test";
import assert from "node:assert/strict";
import { attachedResult, ImageBox } from "../src/agent/attachments.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

test("the box numbers images, cleans their names and refuses what Discord cannot show", () => {
  const box = new ImageBox();
  assert.equal(box.add({ data: PNG, name: "数式 1.png" }), "img1");
  assert.equal(box.add({ data: PNG, name: "数式 1.png" }), "img2");
  assert.deepEqual(Object.values(box.all()).map((a) => a.name), ["1.png", "1-img2.png"]);
  assert.throws(() => box.add({ data: PNG, name: "page.svg" }), /PNG・JPEG・GIF・WebP/);
  box.add({ data: PNG, name: "c.jpg" });
  box.add({ data: PNG, name: "d.gif" });
  assert.throws(() => box.add({ data: PNG, name: "e.png" }), /4枚まで/);
  box.take(["img1", "img3"]);
  assert.deepEqual(box.forReply().map((a) => a.name), ["1-img2.png", "d.gif"]);
});

test("an image tool's result names the id, and shows the image only to a model that can see", () => {
  const seen = attachedResult(new ImageBox(), { data: PNG, name: "x.png" }, true);
  assert.match((seen.content[0] as { text: string }).text, /画像 img1/);
  assert.deepEqual(seen.content[1], { type: "image", data: PNG.toString("base64"), mimeType: "image/png" });
  assert.equal(attachedResult(new ImageBox(), { data: PNG, name: "x.png" }, false).content.length, 1);
});
