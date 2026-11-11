import { ButtonStyle, ComponentType, MessageFlags } from "discord-api-types/v10";
import type { APIActionRowComponent, APIButtonComponent, APIComponentInContainer, APIComponentInActionRow, APIMessageTopLevelComponent, APITextDisplayComponent } from "discord-api-types/v10";
import { truncate } from "../text.ts";
import { SETTINGS_HOME_ID } from "./custom-id.ts";

// Small Components V2 parts the panels and the plan dialog share. Each one
// builds a single component; laying them out stays with each screen.

export type ButtonTone = ButtonStyle.Primary | ButtonStyle.Secondary | ButtonStyle.Danger;

/** A message with one container, as the panels and the dialog send it. */
export type Rendered = { flags: number; components: APIMessageTopLevelComponent[] };

/** Breaks every ``` in the text with a zero-width space, so it cannot close a code block. */
export function escapeFence(text: string): string {
  return text.replaceAll("```", "`​``");
}

/** A code block its own content cannot close. */
export function fence(lang: string, body: string): string {
  return `\`\`\`${lang}\n${escapeFence(body)}\n\`\`\``;
}

/** A Discord timestamp: relative ("R") or full date and time ("f"). */
export function discordTime(iso: string, style: "R" | "f" = "R"): string {
  return `<t:${Math.floor(Date.parse(iso) / 1000)}:${style}>`;
}

/** `disabled` is sent only when given. */
export function button(customId: string, label: string, style: ButtonTone = ButtonStyle.Secondary, disabled?: boolean): APIButtonComponent {
  return { type: ComponentType.Button, custom_id: customId, label, style, ...(disabled !== undefined ? { disabled } : {}) };
}

/** The button every settings section ends with. */
export function settingsHomeButton(): APIButtonComponent {
  return button(SETTINGS_HOME_ID, "← 設定のトップへ");
}

/** A row of the given components, the first `max` of them when given. */
export function actionRow<T extends APIComponentInActionRow>(components: T[], max?: number): APIActionRowComponent<T> {
  return { type: ComponentType.ActionRow, components: max === undefined ? components : components.slice(0, max) };
}

export function textDisplay(content: string): APITextDisplayComponent {
  return { type: ComponentType.TextDisplay, content };
}

const MAX_PANEL_TEXT = 3900;

/**
 * Texts within the panel's share of a message: empty ones are left out, the
 * one that overflows is cut with "…", and once under 50 characters are left
 * the rest are dropped.
 */
export function panelTexts(texts: string[], max = MAX_PANEL_TEXT): APITextDisplayComponent[] {
  let budget = max;
  const parts: APITextDisplayComponent[] = [];
  for (const t of texts) {
    if (!t || budget <= 50) continue;
    const content = truncate(t, budget);
    budget -= content.length;
    parts.push(textDisplay(content));
  }
  return parts;
}

/** A Components V2 message whose children sit in one container. */
export function v2Message(children: APIComponentInContainer[], options: { ephemeral: boolean; accent?: number }): Rendered {
  return {
    flags: (options.ephemeral ? MessageFlags.Ephemeral : 0) | MessageFlags.IsComponentsV2,
    components: [{ type: ComponentType.Container, ...(options.accent !== undefined ? { accent_color: options.accent } : {}), components: children }],
  };
}
