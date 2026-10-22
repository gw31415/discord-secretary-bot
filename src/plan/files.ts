import type { Attachment, Plan, Step } from "./types.ts";

// Images on posts. A post's body names images by id (`files: ["img1"]`); the
// plan carries the images themselves, so the dialog shows exactly what will be
// posted and the executor uploads the same bytes.

/** Operations whose body may carry `files`. */
export const POST_OPS = new Set(["POST /channels/{channel}/messages", "POST /users/{user}/dm"]);
const MAX_PLAN_IMAGE_BYTES = 8 * 1024 * 1024;

export function stepFiles(step: Pick<Step, "op" | "body">): string[] {
  if (!POST_OPS.has(step.op)) return [];
  const files = (step.body as { files?: unknown } | undefined)?.files;
  return Array.isArray(files) ? files.filter((f): f is string => typeof f === "string") : [];
}

/**
 * The images a plan's posts name, looked up in order in `sources` (the images
 * attached in this reply, then those of the plan it replaces). Also checks that
 * every post has text or an image.
 */
export function attachmentsFor(steps: Step[], sources: Array<Record<string, Attachment> | undefined>): { attachments?: Record<string, Attachment>; problems: string[] } {
  const problems: string[] = [];
  const attachments: Record<string, Attachment> = {};
  for (const step of steps) {
    if (!POST_OPS.has(step.op)) continue;
    const files = stepFiles(step);
    const content = (step.body as { content?: unknown } | undefined)?.content;
    if (files.length === 0 && (typeof content !== "string" || content.length === 0)) problems.push(`ステップ ${step.id}: 本文(content)か画像(files)のどちらかが必要です`);
    for (const id of files) {
      const found = sources.find((s) => s?.[id])?.[id];
      if (found) attachments[id] = found;
      else problems.push(`ステップ ${step.id}: 画像 ${id} がありません。attach_image で作ってから、そのIDを files に入れてください`);
    }
  }
  const names = new Map<string, string>();
  for (const step of steps) {
    names.clear();
    for (const id of stepFiles(step)) {
      const name = attachments[id]?.name;
      if (name && names.has(name)) problems.push(`ステップ ${step.id}: 同じファイル名(${name})の画像を1つの投稿に2枚付けられません`);
      if (name) names.set(name, id);
    }
  }
  const bytes = Object.values(attachments).reduce((n, a) => n + Math.ceil((a.data.length * 3) / 4), 0);
  if (bytes > MAX_PLAN_IMAGE_BYTES) problems.push("画像が合わせて8MBを超えています");
  return { ...(Object.keys(attachments).length > 0 ? { attachments } : {}), problems };
}

/** The files to upload with a post, in the order its body names them. */
export function uploadsFor(plan: Pick<Plan, "attachments">, step: Pick<Step, "op" | "body">): Array<{ name: string; data: Buffer }> {
  return stepFiles(step).map((id) => {
    const a = plan.attachments?.[id];
    if (!a) throw new Error(`画像 ${id} が変更に含まれていません`);
    return { name: a.name, data: Buffer.from(a.data, "base64") };
  });
}

/** The dialog's file name for an image: ids are unique within a plan, names may not be. */
export function dialogFileName(id: string, attachment: Attachment): string {
  return `${id}.${attachment.name.split(".").pop()}`;
}

/** Every image in the plan, for showing them in the dialog. */
export function dialogUploads(plan: Pick<Plan, "attachments">): Array<{ name: string; data: Buffer }> {
  return Object.entries(plan.attachments ?? {}).map(([id, a]) => ({ name: dialogFileName(id, a), data: Buffer.from(a.data, "base64") }));
}
