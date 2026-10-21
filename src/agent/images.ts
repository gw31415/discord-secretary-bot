import type { ImageContent } from "@earendil-works/pi-ai";
import type { APIMessage } from "discord-api-types/v10";

// Images the model may look at: attachments and embed images of messages it
// is already allowed to read. Only Discord's own CDN is fetched, so a message
// cannot make the bot request an arbitrary URL.

export const MAX_IMAGES = 4;
const MAX_BYTES = 5 * 1024 * 1024;
const MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const ALLOWED_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

export interface ImageRef {
  url: string;
  /** Known from the attachment; embeds only reveal it on download. */
  contentType?: string;
  size?: number;
}

export function imageRefs(message: Pick<APIMessage, "attachments" | "embeds">): ImageRef[] {
  const refs: ImageRef[] = [];
  for (const a of message.attachments) {
    if (a.content_type && MIME_TYPES.has(a.content_type.split(";")[0]!)) refs.push({ url: a.url, contentType: a.content_type, size: a.size });
  }
  for (const e of message.embeds) {
    for (const media of [e.image, e.thumbnail]) {
      if (media?.proxy_url) refs.push({ url: media.proxy_url });
    }
  }
  return refs;
}

export async function downloadImages(refs: ImageRef[], fetchFn: typeof fetch = fetch): Promise<ImageContent[]> {
  const images: ImageContent[] = [];
  for (const ref of refs) {
    if (images.length >= MAX_IMAGES) break;
    if (ref.size !== undefined && ref.size > MAX_BYTES) continue;
    let url: URL;
    try {
      url = new URL(ref.url);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname)) continue;
    try {
      const res = await fetchFn(url, { redirect: "error", signal: AbortSignal.timeout(10_000) });
      const mimeType = (res.headers.get("content-type") ?? ref.contentType ?? "").split(";")[0]!.trim();
      if (!res.ok || !MIME_TYPES.has(mimeType)) continue;
      const body = Buffer.from(await res.arrayBuffer());
      if (body.length > MAX_BYTES) continue;
      images.push({ type: "image", data: body.toString("base64"), mimeType });
    } catch {
      // An image that cannot be fetched is skipped; the text still goes through.
    }
  }
  return images;
}
