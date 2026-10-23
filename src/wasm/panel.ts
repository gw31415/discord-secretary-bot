import type { API } from "@discordjs/core";
import { ButtonStyle, ComponentType, InteractionType, MessageFlags, TextInputStyle } from "discord-api-types/v10";
import type { APIButtonComponent, APIComponentInContainer, APIInteraction, APIModalInteractionResponseCallbackData, APIModalSubmitInteraction } from "discord-api-types/v10";
import type { WasmModule } from "../db.ts";
import { modalValue } from "../discord/modal.ts";
import { SETTINGS_HOME_ID } from "../rules/panel.ts";
import type { Rendered } from "../rules/panel.ts";
import { MAX_MEMORY_PAGES, MAX_MODULE_BYTES } from "./module.ts";
import { MAX_BYTES_PER_USER, MAX_MODULES_PER_USER, ModuleRejected, sizeLabel } from "./registry.ts";
import type { WasmRegistry } from "./registry.ts";

// The "Wasm" section of /settings: the presser's own modules. A module is
// usually added in conversation (attached and talked over with the bot); the
// modal's file field here is the other way in. Either way it only does
// something once a rule runs it. Modules belong to the person, like the
// rest of /settings, so the section is the same in every server.

export const WASM_SECTION_ID = "wasm:home:";
const ACTIONS = new Set(["home", "open", "upload", "uploaded", "rename", "renamed", "del", "del2"]);
type WasmAction = "home" | "open" | "upload" | "uploaded" | "rename" | "renamed" | "del" | "del2";

export function wasmCustomId(action: WasmAction, arg = ""): string {
  return `wasm:${action}:${arg}`;
}

function parse(id: string): { action: WasmAction; arg: string } | null {
  const m = /^wasm:(\w+):([0-9a-f]*)$/.exec(id);
  return m && ACTIONS.has(m[1]!) ? { action: m[1] as WasmAction, arg: m[2]! } : null;
}

function button(id: string, label: string, style: ButtonStyle.Primary | ButtonStyle.Secondary | ButtonStyle.Danger = ButtonStyle.Secondary): APIButtonComponent {
  return { type: ComponentType.Button, custom_id: id, label, style };
}

function view(texts: string[], rows: APIButtonComponent[][], select?: APIComponentInContainer): Rendered {
  const components: APIComponentInContainer[] = texts.filter(Boolean).map((content) => ({ type: ComponentType.TextDisplay, content: content.slice(0, 3900) }));
  if (select) components.push(select);
  for (const r of rows) if (r.length) components.push({ type: ComponentType.ActionRow, components: r.slice(0, 3) });
  return { flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2, components: [{ type: ComponentType.Container, components }] };
}

const HOW_TO = [
  "WASI(preview 1)のコマンドとしてビルドした .wasm を登録できます(Rust の wasm32-wasip1、Go の GOOS=wasip1、C の wasi-sdk、Zig など)。",
  "**登録のしかた**: Botにメンションして .wasm を添付し、何に使いたいかを相談すると、Botが登録してルールやコマンドの案を出します。下の「Wasmを登録」から登録だけしておくこともできます。",
  "標準入力でイベントなどのJSONを受け取り、標準出力に `{ \"steps\": [...], \"reply\": \"…\", \"state\": … }` を書きます。Discordの読み取りなどはホスト関数 `secretary.call` で呼びます。",
  "登録しただけでは動きません。会話で「このWasmを /xxx コマンドにして」のように頼むと、ルールとして確認画面が出ます。実行はルールの作成者の権限の範囲だけです。",
].join("\n");

export function homeView(modules: WasmModule[], usage: (sha: string) => number, notice?: string): Rendered {
  const total = modules.reduce((n, m) => n + m.size, 0);
  const texts = [
    "## Wasm",
    HOW_TO,
    `-# 上限: 1個${MAX_MODULE_BYTES / 1024 / 1024}MB・一人${MAX_MODULES_PER_USER}個・合計${MAX_BYTES_PER_USER / 1024 / 1024}MB(いま ${modules.length}個・${sizeLabel(total)})。実行は1回30秒・メモリ${MAX_MEMORY_PAGES / 16}MiBまで。`,
    modules.length ? "" : "まだ登録していません。",
    notice ? `-# ${notice}` : "",
  ];
  const select: APIComponentInContainer | undefined = modules.length
    ? {
        type: ComponentType.ActionRow,
        components: [{
          type: ComponentType.StringSelect,
          custom_id: wasmCustomId("open"),
          placeholder: `モジュールを開く(${modules.length}個)`,
          options: modules.slice(0, 25).map((m) => ({
            label: m.name.slice(0, 100),
            value: m.sha256,
            description: `${sizeLabel(m.size)} · ${m.sha256.slice(0, 12)} · ルール${usage(m.sha256)}件${m.info.producers[0] ? ` · ${m.info.producers[0]}` : ""}`.slice(0, 100),
          })),
        }],
      }
    : undefined;
  return view(texts, [[button(wasmCustomId("upload"), "Wasmを登録", ButtonStyle.Primary), button(SETTINGS_HOME_ID, "← 設定のトップへ")]], select);
}

export function detailView(module: WasmModule, latest: boolean, rules: Array<{ name: string; enabled: boolean; guildId: string; mine: boolean }>, confirmDelete = false, notice?: string): Rendered {
  const texts = [
    `## ${module.name}${latest ? "" : "(古い版)"}`,
    [
      `**sha256**: \`${module.sha256}\``,
      `**大きさ**: ${sizeLabel(module.size)} · **メモリ**: ${module.info.memory.min * 64}KiB から最大 ${module.info.memory.max / 16}MiB`,
      `**ビルド**: ${module.info.producers.join("、") || "記載なし"}`,
      `**import**: ${module.info.imports.map((i) => `\`${i}\``).join(" ").slice(0, 900) || "なし"}`,
      `**登録**: <t:${Math.floor(Date.parse(module.createdAt) / 1000)}:f>`,
    ].join("\n"),
    rules.length
      ? `**使っているルール**\n${rules.map((r) => `${r.enabled ? "🟢" : "⏸️"} ${r.name}${r.mine ? "" : "(ほかの人のルール)"}`).join("\n")}`
      : "使っているルールはありません。",
    confirmDelete ? "⚠️ 本当に削除しますか?" : "",
    notice ? `-# ${notice}` : "",
  ];
  const rows = confirmDelete
    ? [[button(wasmCustomId("del2", module.sha256), "削除する", ButtonStyle.Danger), button(wasmCustomId("open", module.sha256), "やめる")]]
    : [[button(wasmCustomId("rename", module.sha256), "名前を変える"), button(wasmCustomId("del", module.sha256), "削除", ButtonStyle.Danger), button(wasmCustomId("home"), "← 一覧へ")]];
  return view(texts, rows);
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

  #home(userId: string, notice?: string): Rendered {
    const { registry } = this.#deps;
    return homeView(registry.list(userId), (sha) => registry.rulesUsing(sha).length, notice);
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
    const userId = interaction.member?.user.id ?? interaction.user?.id;
    if (!userId) return true;
    const { api, registry } = this.#deps;
    const update = (rendered: Rendered) => api.interactions.updateMessage(interaction.id, interaction.token, { ...rendered, flags: MessageFlags.IsComponentsV2 });
    const sha = parsed.arg || ("values" in interaction.data ? (interaction.data.values?.[0] ?? "") : "");
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
          // Downloading and checking can take longer than the 3 seconds an answer may wait.
          await api.interactions.deferMessageUpdate(interaction.id, interaction.token);
          const edit = (rendered: Rendered) => api.interactions.editReply(interaction.application_id, interaction.token, { ...rendered, flags: MessageFlags.IsComponentsV2 });
          try {
            const res = await (this.#deps.fetch ?? fetch)(file.url);
            if (!res.ok) throw new ModuleRejected(`ファイルを取得できませんでした(${res.status})`);
            const name = modalValue(interaction, "name")?.trim() || file.filename;
            const { module, replaced } = await registry.upload(userId, name, new Uint8Array(await res.arrayBuffer()));
            await edit(this.#detail(userId, module.sha256, { notice: `登録しました${replaced ? `(使われていない古い版${replaced}個を消しました)` : ""}。会話で「${module.name} を使って…」と頼むとルールにできます` }));
          } catch (e) {
            if (!(e instanceof ModuleRejected)) this.#deps.log("Wasmの登録に失敗", e);
            await edit(this.#home(userId, `登録できませんでした: ${e instanceof Error ? e.message : String(e)}`.slice(0, 900)));
          }
          return true;
        }
        case "del":
          await update(this.#detail(userId, sha, { confirmDelete: true }));
          return true;
        case "del2": {
          const module = registry.remove(userId, sha);
          await update(this.#home(userId, `「${module.name}」を削除しました`));
          return true;
        }
      }
    } catch (e) {
      if (e instanceof ModuleRejected) {
        await api.interactions.reply(interaction.id, interaction.token, { content: e.message.slice(0, 1800), flags: MessageFlags.Ephemeral, allowed_mentions: { parse: [] } });
        return true;
      }
      throw e;
    }
    return true;
  }
}
