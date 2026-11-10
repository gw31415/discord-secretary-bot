// The first segment of the custom ids the bot's own panels and dialogs use.
// Presses on any other id go to INTERACTION_CREATE rules, so a new panel's
// namespace belongs here. This module imports nothing, so any panel can use it.

export const NS = { plan: "plan", rule: "rule", wasm: "wasm", llm: "llm", widen: "widen" } as const;

export const BOT_NAMESPACES: ReadonlySet<string> = new Set(Object.values(NS));

/** The settings panel's home (CUSTOM_ID.page("home") in llm/panel.ts). */
export const SETTINGS_HOME_ID = `${NS.llm}:page:home`;
/** The Wasm section's home (wasmCustomId("home") in wasm/panel.ts). */
export const WASM_HOME_ID = `${NS.wasm}:home:`;
