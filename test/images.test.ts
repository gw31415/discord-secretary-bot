import { test } from "node:test";
import assert from "node:assert/strict";
import { downloadImages, imageRefs, MAX_IMAGES } from "../src/agent/images.ts";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function stubFetch(seen: string[]): typeof fetch {
  return (async (url: string | URL | Request) => {
    seen.push(String(url));
    return new Response(png, { headers: { "content-type": "image/png" } });
  }) as typeof fetch;
}

test("image attachments and embed images are picked up, other files are not", () => {
  const refs = imageRefs({
    attachments: [
      { id: "1", filename: "a.png", url: "https://cdn.discordapp.com/a.png", proxy_url: "", size: 10, content_type: "image/png" },
      { id: "2", filename: "b.pdf", url: "https://cdn.discordapp.com/b.pdf", proxy_url: "", size: 10, content_type: "application/pdf" },
    ],
    embeds: [{ image: { url: "https://example.com/x.png", proxy_url: "https://media.discordapp.net/external/x.png" } }],
  } as never);
  assert.deepEqual(refs.map((r) => r.url), ["https://cdn.discordapp.com/a.png", "https://media.discordapp.net/external/x.png"]);
});

test("only Discord's CDN is fetched, and at most a few images", async () => {
  const seen: string[] = [];
  const refs = [
    { url: "https://example.com/evil.png" },
    { url: "http://cdn.discordapp.com/plain-http.png" },
    ...Array.from({ length: MAX_IMAGES + 2 }, (_, i) => ({ url: `https://cdn.discordapp.com/${i}.png` })),
  ];
  const images = await downloadImages(refs, stubFetch(seen));
  assert.equal(images.length, MAX_IMAGES);
  assert.ok(seen.every((u) => u.startsWith("https://cdn.discordapp.com/")), seen.join(","));
  assert.deepEqual(images[0], { type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" });
});

test("oversized or non-image responses are skipped", async () => {
  const html = (async () => new Response("<html>", { headers: { "content-type": "text/html" } })) as typeof fetch;
  assert.deepEqual(await downloadImages([{ url: "https://cdn.discordapp.com/x.png" }], html), []);
  assert.deepEqual(await downloadImages([{ url: "https://cdn.discordapp.com/x.png", size: 50 * 1024 * 1024 }], stubFetch([])), []);
});
