import type { API } from "@discordjs/core";
import { ButtonStyle, ComponentType, InteractionType, TextInputStyle } from "discord-api-types/v10";
import type { APIButtonComponent, APIComponentInContainer, APIInteraction, APIModalInteractionResponseCallbackData, APIModalSubmitInteraction } from "discord-api-types/v10";
import type { WasmModule, WasmSource } from "../db.ts";
import { modalValue } from "../discord/modal.ts";
import { NS } from "../discord/custom-id.ts";
import { actionRow, button, discordTime, escapeFence, panelTexts, settingsHomeButton, v2Message } from "../discord/ui.ts";
import type { Rendered } from "../discord/ui.ts";
import { MAX_MODULE_BYTES } from "./module.ts";
import { ModuleRejected, sizeLabel } from "./registry.ts";
import type { WasmRegistry } from "./registry.ts";
import { errorMessage } from "../errors.ts";
import { editV2, replyEphemeral, selectedValues, updateV2, userIdOf } from "../discord/respond.ts";

// The "Wasm" section of /settings: the presser's own modules. A module is
// usually added in conversation (attached, or compiled from source, and
// talked over with the bot); the modal's file field here is the other way in. Either way it only does
// something once a rule runs it. Modules belong to the person, like the
// rest of /settings, so the section is the same in every server.

const ACTIONS = new Set(["home", "open", "upload", "uploaded", "rename", "renamed", "del", "del2", "src"]);
type WasmAction = "home" | "open" | "upload" | "uploaded" | "rename" | "renamed" | "del" | "del2" | "src";

export function wasmCustomId(action: WasmAction, arg = ""): string {
  return `${NS.wasm}:${action}:${arg}`;
}

function parse(id: string): { action: WasmAction; arg: string } | null {
  const m = /^wasm:(\w+):([0-9a-f]*)$/.exec(id);
  return m && ACTIONS.has(m[1]!) ? { action: m[1] as WasmAction, arg: m[2]! } : null;
}

const MAX_TEXT = 3900;

/** A screen's parts in order: texts share the message's text budget, rows of buttons hold up to three, components stand as they are. */
function view(parts: Array<string | APIButtonComponent[] | APIComponentInContainer>): Rendered {
  let room = MAX_TEXT;
  const components: APIComponentInContainer[] = [];
  for (const part of parts) {
    if (Array.isArray(part)) {
      if (part.length) components.push(actionRow(part, 3));
    } else if (typeof part === "string") {
      const [text] = panelTexts([part], room);
      if (!text) continue;
      room -= text.content.length;
      components.push(text);
    } else {
      components.push(part);
    }
  }
  return v2Message(components, { ephemeral: true });
}

/** `busy` leaves out the button that adds a module, while one is being registered. */
export function homeView(modules: WasmModule[], usage: (sha: string) => number, notice?: string, languages: string[] = [], busy = false): Rendered {
  const total = modules.reduce((n, m) => n + m.size, 0);
  const select: APIComponentInContainer | undefined = modules.length
    ? {
        type: ComponentType.ActionRow,
        components: [{
          type: ComponentType.StringSelect,
          custom_id: wasmCustomId("open"),
          placeholder: modules.length > SELECT_MAX ? `モジュールを開く(${modules.length}個中${SELECT_MAX}個)` : `モジュールを開く(${modules.length}個)`,
          options: modules.slice(0, SELECT_MAX).map((m) => ({
            label: m.name.slice(0, 100),
            value: m.sha256,
            description: `${sizeLabel(m.size)} · ${m.sha256.slice(0, 12)} · ルール${usage(m.sha256)}件${m.info.producers[0] ? ` · ${m.info.producers[0]}` : ""}`.slice(0, 100),
          })),
        }],
      }
    : undefined;
  // The limits are said by the error that meets them and in docs/wasm.md, so only the usage is shown.
  return view([
    "## Wasm",
    `Botに ${languages.length ? ".wasm かソースを" : ".wasm を"}渡すか、「Wasmを登録」で登録します`,
    modules.length ? `-# ${modules.length}個 · ${sizeLabel(total)}` : "まだ登録していません。",
    ...(select ? [select] : []),
    notice ? `-# ${notice}` : "",
    busy ? [] : [button(wasmCustomId("upload"), "Wasmを登録", ButtonStyle.Primary)],
    [settingsHomeButton()],
  ]);
}

/** What a select holds at most. */
const SELECT_MAX = 25;

/** A module's sha256, memory, build and imports: under its source when it has one, else on its own screen. */
function technicalLines(module: WasmModule): string[] {
  return [
    `**sha256**: \`${module.sha256}\``,
    `**メモリ**: ${module.info.memory.min * 64}KiB から最大 ${module.info.memory.max / 16}MiB`,
    `**ビルド**: ${module.info.producers.join("、") || "記載なし"}`,
    `**インポート**: ${module.info.imports.map((i) => `\`${i}\``).join(" ").slice(0, 900) || "なし"}`,
  ];
}

/** From the parts to the whole: the facts, the source, then under a divider the status line and the buttons. */
export function detailView(module: WasmModule, latest: boolean, rules: Array<{ name: string; enabled: boolean; guildId: string; mine: boolean }>, confirmDelete = false, notice?: string): Rendered {
  const parts: Array<string | APIButtonComponent[] | APIComponentInContainer> = [
    `## ${module.name}${latest ? "" : "(古い版)"}`,
    [
      `**大きさ**: ${sizeLabel(module.size)}`,
      ...(module.source ? [`**ソース**: ${module.source.language}・${module.source.files}ファイル(Botがコンパイル)`] : []),
      `**登録**: ${discordTime(module.createdAt)}`,
      // An uploaded module has no source screen to hold the rest.
      ...(module.source ? [] : technicalLines(module)),
    ].join("\n"),
    rules.length
      ? `**使っているルール**\n${rules.map((r) => `${r.enabled ? "🟢 動作中" : "⏸️ 停止中"} · ${r.name}${r.mine ? "" : "(ほかの人のルール)"}`).join("\n")}`
      : "使っているルールはありません。",
  ];
  if (confirmDelete) {
    parts.push(`⚠️ 「${module.name}」を削除します`, notice ? `-# ${notice}` : "");
    parts.push([button(wasmCustomId("del2", module.sha256), "削除する", ButtonStyle.Danger), button(wasmCustomId("open", module.sha256), "やめる")]);
    return view(parts);
  }
  parts.push(module.source ? [button(wasmCustomId("src", module.sha256), "ソースを見る")] : [], { type: ComponentType.Separator }, notice ? `-# ${notice}` : "");
  parts.push([button(wasmCustomId("rename", module.sha256), "名前を変える"), button(wasmCustomId("del", module.sha256), "削除", ButtonStyle.Danger)], [button(wasmCustomId("home"), "← 一覧へ")]);
  return view(parts);
}

const MAX_SOURCE_SHOWN = 3400;

/** The sources a module was compiled from, as much as fits in one message, then the module's technical facts. */
export function sourceView(module: WasmModule, source: WasmSource): Rendered {
  const facts = technicalLines(module).join("\n");
  let room = MAX_SOURCE_SHOWN - facts.length;
  const parts: string[] = [];
  for (const file of source.files) {
    const head = `**${file.path}**`;
    const body = escapeFence(file.content);
    if (room < head.length + 40) {
      parts.push(`-# ほか ${source.files.length - parts.length}ファイル(会話で頼むと全部見せます)`);
      break;
    }
    const shown = body.length > room - head.length - 20 ? `${body.slice(0, room - head.length - 20)}\n…` : body;
    // Escaped before cutting, so the fence is written by hand rather than escaping again.
    parts.push(`${head}\n\`\`\`\n${shown}\n\`\`\``);
    room -= head.length + shown.length + 10;
  }
  return view([`## ${module.name} のソース(${source.language} ${source.version})`, ...parts, facts, [button(wasmCustomId("open", module.sha256), `← ${module.name} へ`)]]);
}

function uploadModal(): APIModalInteractionResponseCallbackData {
  return {
    custom_id: wasmCustomId("uploaded"),
    title: "Wasmモジュールを登録",
    components: [
      {
        type: ComponentType.Label,
        label: ".wasm ファイル",
        description: `WASI のコマンドとしてビルドしたもの(${MAX_MODULE_BYTES / 1024 / 1024}MBまで)`,
        component: { type: ComponentType.FileUpload, custom_id: "file", min_values: 1, max_values: 1, required: true },
      },
      {
        type: ComponentType.Label,
        label: "名前",
        description: "省略するとファイル名。同じ名前で登録すると新しい版になります",
        component: { type: ComponentType.TextInput, custom_id: "name", style: TextInputStyle.Short, required: false, max_length: 40 },
      },
    ],
  } as APIModalInteractionResponseCallbackData;
}

function renameModal(module: WasmModule): APIModalInteractionResponseCallbackData {
  return {
    custom_id: wasmCustomId("renamed", module.sha256),
    title: "名前を変える",
    components: [{ type: ComponentType.Label, label: "名前", component: { type: ComponentType.TextInput, custom_id: "name", style: TextInputStyle.Short, required: true, max_length: 40, value: module.name } }],
  } as APIModalInteractionResponseCallbackData;
}

/** The attachment a modal's file field carries. */
function uploadedFile(interaction: APIModalSubmitInteraction, customId: string): { url: string; size: number; filename: string } | undefined {
  for (const c of interaction.data.components as unknown as Array<{ component?: { type: number; custom_id: string; values?: string[] } }>) {
    const inner = c.component;
    if (inner?.type === ComponentType.FileUpload && inner.custom_id === customId) {
      const id = inner.values?.[0];
      const file = id ? interaction.data.resolved?.attachments?.[id] : undefined;
      if (file) return { url: file.url, size: file.size, filename: file.filename };
    }
  }
  return undefined;
}

export interface WasmPanelDeps {
  api: API;
  registry: WasmRegistry;
  fetch?: typeof fetch;
  log: (message: string, error?: unknown) => void;
}

export class WasmPanel {
  readonly #deps: WasmPanelDeps;

  constructor(deps: WasmPanelDeps) {
    this.#deps = deps;
  }

  #home(userId: string, notice?: string, busy = false): Rendered {
    const { registry } = this.#deps;
    return homeView(registry.list(userId), (sha) => registry.rulesUsing(sha).length, notice, registry.compiler?.languages().map((l) => l.name) ?? [], busy);
  }

  #detail(userId: string, sha: string, extra: { confirmDelete?: boolean; notice?: string } = {}): Rendered {
    const { registry } = this.#deps;
    const module = registry.list(userId).find((m) => m.sha256 === sha);
    if (!module) return this.#home(userId, "そのモジュールはもうありません");
    const rules = registry.rulesUsing(sha).map((r) => ({ name: r.name, enabled: r.enabled, guildId: r.guildId, mine: r.ownerId === userId }));
    return detailView(module, registry.isLatest(module), rules, extra.confirmDelete, extra.notice);
  }

  async handleInteraction(interaction: APIInteraction): Promise<boolean> {
    if (interaction.type !== InteractionType.MessageComponent && interaction.type !== InteractionType.ModalSubmit) return false;
    const parsed = parse(interaction.data.custom_id);
    if (!parsed) return false;
    const userId = userIdOf(interaction);
    if (!userId) return true;
    const { api, registry } = this.#deps;
    const update = (rendered: Rendered) => updateV2(api, interaction, rendered);
    const sha = parsed.arg || (selectedValues(interaction)[0] ?? "");
    try {
      switch (parsed.action) {
        case "home":
          await update(this.#home(userId));
          return true;
        case "open":
          await update(this.#detail(userId, sha));
          return true;
        case "upload":
          await api.interactions.createModal(interaction.id, interaction.token, uploadModal());
          return true;
        case "rename": {
          const module = registry.list(userId).find((m) => m.sha256 === sha);
          if (!module) await update(this.#home(userId, "そのモジュールはもうありません"));
          else await api.interactions.createModal(interaction.id, interaction.token, renameModal(module));
          return true;
        }
        case "renamed": {
          if (interaction.type !== InteractionType.ModalSubmit) return true;
          registry.rename(userId, sha, modalValue(interaction, "name") ?? "");
          await update(this.#detail(userId, sha, { notice: "名前を変えました。この名前でルールに使えます" }));
          return true;
        }
        case "uploaded": {
          if (interaction.type !== InteractionType.ModalSubmit) return true;
          const file = uploadedFile(interaction, "file");
          if (!file) {
            await update(this.#home(userId, "ファイルが見つかりませんでした"));
            return true;
          }
          if (file.size > MAX_MODULE_BYTES) {
            await update(this.#home(userId, `.wasm は${MAX_MODULE_BYTES / 1024 / 1024}MBまでです`));
            return true;
          }
          // Downloading and checking can take longer than the 3 seconds an answer may wait, so the status line says it is working.
          await update(this.#home(userId, "登録中…", true));
          const edit = (rendered: Rendered) => editV2(api, interaction, rendered);
          try {
            const res = await (this.#deps.fetch ?? fetch)(file.url);
            if (!res.ok) throw new ModuleRejected(`ファイルを取得できません(${res.status})`);
            const name = modalValue(interaction, "name")?.trim() || file.filename;
            const { module, replaced } = await registry.upload(userId, name, new Uint8Array(await res.arrayBuffer()));
            await edit(this.#detail(userId, module.sha256, { notice: `登録しました${replaced ? `(使われていない古い版${replaced}個を消しました)` : ""}。会話で「${module.name} を使って…」と頼むとルールにできます` }));
          } catch (e) {
            if (!(e instanceof ModuleRejected)) this.#deps.log("Wasmの登録に失敗", e);
            await edit(this.#home(userId, (e instanceof ModuleRejected ? `登録できませんでした。${errorMessage(e)}` : "登録できませんでした。もう一度試してください。").slice(0, 900)));
          }
          return true;
        }
        case "del":
          await update(this.#detail(userId, sha, { confirmDelete: true }));
          return true;
        case "src": {
          const module = registry.list(userId).find((m) => m.sha256 === sha);
          const source = module && registry.source(sha);
          await update(module && source ? sourceView(module, source) : this.#home(userId, "そのモジュールのソースはありません"));
          return true;
        }
        case "del2": {
          const module = registry.remove(userId, sha);
          await update(this.#home(userId, `「${module.name}」を削除しました`));
          return true;
        }
      }
    } catch (e) {
      if (e instanceof ModuleRejected) {
        await replyEphemeral(api, interaction, e.message.slice(0, 1800));
        return true;
      }
      throw e;
    }
    return true;
  }
}
