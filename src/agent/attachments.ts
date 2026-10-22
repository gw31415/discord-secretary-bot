import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { renderImage } from "../render.ts";
import { MAX_IMAGES_PER_REPLY } from "../plan/types.ts";
import type { Attachment } from "../plan/types.ts";

// Images the agent draws while answering. Each gets an id ("img1"); the ones a
// proposed change posts go with the change, and the rest go out with the reply.

function fileName(raw: string | undefined, id: string): string {
  const base = (raw ?? "").replace(/\.png$/i, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `${base || id}.png`;
}

export class ImageBox {
  #items = new Map<string, Attachment>();
  #taken = new Set<string>();

  add(png: Buffer, name?: string): string {
    if (this.#items.size >= MAX_IMAGES_PER_REPLY) throw new Error(`画像は1回の返答で${MAX_IMAGES_PER_REPLY}枚までです`);
    const id = `img${this.#items.size + 1}`;
    let file = fileName(name, id);
    if ([...this.#items.values()].some((a) => a.name === file)) file = `${file.slice(0, -4)}-${id}.png`;
    this.#items.set(id, { name: file, data: png.toString("base64") });
    return id;
  }

  all(): Record<string, Attachment> {
    return Object.fromEntries(this.#items);
  }

  /** Images a proposed change carries; they are not attached to the reply as well. */
  take(ids: Iterable<string>): void {
    for (const id of ids) this.#taken.add(id);
  }

  /** Images still to go out with the reply. */
  forReply(): Attachment[] {
    return [...this.#items].filter(([id]) => !this.#taken.has(id)).map(([, a]) => a);
  }
}

export function imageTool(box: ImageBox, seesImages: boolean): AgentTool<any> {
  const parameters = Type.Object({
    tex: Type.Optional(Type.String({ description: "数式のTeX(ディスプレイ数式として描画。$ は不要)。例: \\int_0^1 x^2\\,dx = \\frac{1}{3}" })),
    svg: Type.Optional(Type.String({ description: "SVG全体。width・height か viewBox を付けます。外部の画像・フォント・CSSは読めません" })),
    name: Type.Optional(Type.String({ description: "ファイル名(英数字)。例: formula" })),
  });
  return {
    name: "attach_image",
    label: "画像を作る",
    description:
      "TeX の数式か SVG から PNG 画像を作ります。作った画像は返答に添付されます。propose_plan の投稿(DM含む)に付けるときは、そのステップの body に files: [\"img1\"] のように画像のIDを入れます(そのときは返答には付きません)。",
    parameters,
    execute: async (_id, input) => {
      const params = input as { tex?: string; svg?: string; name?: string };
      const image = renderImage({ ...(params.tex !== undefined ? { tex: params.tex } : {}), ...(params.svg !== undefined ? { svg: params.svg } : {}) });
      const id = box.add(image.png, params.name);
      const text = `画像 ${id}(${box.all()[id]!.name}、${image.width}×${image.height})を作りました。`;
      return {
        content: [
          { type: "text" as const, text },
          ...(seesImages ? [{ type: "image" as const, data: image.png.toString("base64"), mimeType: "image/png" }] : []),
        ],
        details: {},
      };
    },
  };
}
