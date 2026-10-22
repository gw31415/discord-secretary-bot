import type { ImageContent } from "@earendil-works/pi-ai";
import type { APIMessage } from "discord-api-types/v10";
import { forModel, MAX_SOURCE_BYTES } from "../media.ts";

// Images the model may look at: attachments and embed images of messages it
// is already allowed to read. Only Discord's own CDN is fetched, so a message
// cannot make the bot request an arbitrary URL. Large images are shrunk before
// the model sees them, so a phone photo costs a fraction of the tokens.

export const MAX_IMAGES = 4;
const MAX_BYTES = MAX_SOURCE_BYTES;
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

/** The image's bytes as Discord's CDN serves them; null when it is not an image we may fetch. */
export async function fetchImage(ref: ImageRef, fetchFn: typeof fetch = fetch): Promise<{ data: Buffer; mimeType: string } | null> {
  if (ref.size !== undefined && ref.size > MAX_BYTES) return null;
  let url: URL;
  try {
    url = new URL(ref.url);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname)) return null;
  try {
    const res = await fetchFn(url, { redirect: "error", signal: AbortSignal.timeout(10_000) });
    const mimeType = (res.headers.get("content-type") ?? ref.contentType ?? "").split(";")[0]!.trim();
    if (!res.ok || !MIME_TYPES.has(mimeType)) return null;
    const data = Buffer.from(await res.arrayBuffer());
    return data.length > MAX_BYTES ? null : { data, mimeType };
  } catch {
    return null;
  }
}

export async function downloadImages(refs: ImageRef[], fetchFn: typeof fetch = fetch): Promise<ImageContent[]> {
  const fetched = await Promise.all(refs.slice(0, MAX_IMAGES * 2).map((ref) => fetchImage(ref, fetchFn)));
  const images: ImageContent[] = [];
  // An image that cannot be fetched is skipped; the text still goes through.
  for (const image of fetched) {
    if (!image || images.length >= MAX_IMAGES) continue;
    const small = await forModel(image.data, image.mimeType);
    images.push({ type: "image", data: small.data.toString("base64"), mimeType: small.mimeType });
  }
  return images;
}
