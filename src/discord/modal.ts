import { ComponentType } from "discord-api-types/v10";
import type { APIModalSubmitInteraction } from "discord-api-types/v10";

/** The value typed into a modal's text input, wherever the input sits in the layout. */
export function modalValue(interaction: APIModalSubmitInteraction, customId: string): string | undefined {
  for (const row of interaction.data.components) {
    const inner = "components" in row ? row.components : "component" in row ? [row.component] : [];
    for (const c of inner) {
      if (c.type === ComponentType.TextInput && c.custom_id === customId) return c.value;
    }
  }
  return undefined;
}
