import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { MAX_IMAGES_PER_BOX, MAX_IMAGES_PER_REPLY } from "../plan/types.ts";
import type { Attachment } from "../plan/types.ts";

// The place where tools put images for the bot to post. A tool that makes or
// fetches an image adds it here and gets an id ("img1"); images a proposed
// change names in a post's `files` go with that change, and the rest go out
// with the reply. Outside tools plug in through `ImageTools`.

/** An image a tool made; `name` carries the extension. */
export interface ImageFile {
  data: Buffer;
  name: string;
}

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Tools that add images to the reply's box; `seesImages` says whether to show them to the model. */
export type ImageTools = (box: ImageBox, seesImages: boolean) => AgentTool<any>[];

export function mimeOf(name: string): string | undefined {
  return MIME[name.split(".").pop()!.toLowerCase()];
}

export class ImageBox {
  #items = new Map<string, Attachment>();
  #taken = new Set<string>();
  #next = 1;

  /**
   * Throws once the reply has made as many images as it may, so a tool can stop
   * before making one. Images a change uses (new emojis, stickers) count here
   * but not toward what the reply itself carries.
   */
  checkRoom(): void {
    if (this.#items.size >= MAX_IMAGES_PER_BOX) throw new Error(`画像は1回の返答で${MAX_IMAGES_PER_BOX}枚までです`);
  }

  add(file: ImageFile): string {
    this.checkRoom();
    return this.#put(file);
  }

  /** An image only a proposed change uses (a new emoji or sticker): it never goes out with the reply. */
  addForPlan(file: ImageFile): string {
    this.checkRoom();
    const id = this.#put(file);
    this.#taken.add(id);
    return id;
  }

  #put(file: ImageFile): string {
    if (!mimeOf(file.name)) throw new Error("PNG・JPEG・GIF・WebP・SVG の画像だけ添付できます");
    if (file.data.length > MAX_IMAGE_BYTES) throw new Error("画像は8MBまでです");
    const id = `img${this.#next++}`;
    const dot = file.name.lastIndexOf(".");
    const base = file.name.slice(0, dot).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || id;
    const ext = file.name.slice(dot + 1).toLowerCase();
    let name = `${base}.${ext}`;
    if ([...this.#items.values()].some((a) => a.name === name)) name = `${base}-${id}.${ext}`;
    this.#items.set(id, { name, data: file.data.toString("base64") });
    return id;
  }

  /** An image already in the box, for tools that work on it (convert_image). */
  get(id: string): ImageFile | undefined {
    const a = this.#items.get(id);
    return a && { data: Buffer.from(a.data, "base64"), name: a.name };
  }

  all(): Record<string, Attachment> {
    return Object.fromEntries(this.#items);
  }

  /** Drops images made by code that then failed, so they do not go out. */
  discard(ids: Iterable<string>): void {
    for (const id of ids) this.#items.delete(id);
  }

  /** Images a proposed change carries; they are not attached to the reply as well. */
  take(ids: Iterable<string>): void {
    for (const id of ids) this.#taken.add(id);
  }

  /** Images still to go out with the reply: the first ones a message can carry. */
  forReply(): Attachment[] {
    return [...this.#items].filter(([id]) => !this.#taken.has(id)).map(([, a]) => a).slice(0, MAX_IMAGES_PER_REPLY);
  }
}

/** What an image tool returns after adding its image: the id, and the image itself when the model can see it. */
export function attachedResult(box: ImageBox, file: ImageFile, seesImages: boolean): AgentToolResult<{ id: string }> {
  const id = box.add(file);
  const name = box.all()[id]!.name;
  return {
    content: [
      { type: "text", text: `画像 ${id}(${name})を用意しました。変更案に使わなければ返答に添付されます。propose_plan では投稿の body.files、絵文字の image、スタンプの file に "${id}" を入れます。` },
      // An SVG is only shown once converted; tools that hand one over say so in their own words.
      ...(seesImages && mimeOf(name) !== "image/svg+xml" ? [{ type: "image" as const, data: file.data.toString("base64"), mimeType: mimeOf(name)! }] : []),
    ],
    details: { id },
  };
}
