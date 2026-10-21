import { ChannelType, OverwriteType, PermissionFlagsBits as P } from "discord-api-types/v10";
import type { GuildState } from "../src/discord/permissions.ts";

export const GUILD = "100";
export const SELF = "999";
export const MOD_ROLE = "200";

/**
 * general: everyone. staff: hidden from @everyone, visible to MOD_ROLE.
 * readonly: everyone can view but not read history. thread1: public thread under general.
 */
export function makeGuild(): GuildState {
  const everyone = { id: GUILD, permissions: P.ViewChannel | P.ReadMessageHistory | P.SendMessages, position: 0 };
  const mod = { id: MOD_ROLE, permissions: P.ViewAuditLog | P.ManageMessages, position: 1 };
  return {
    id: GUILD,
    ownerId: "1",
    roles: new Map([[everyone.id, everyone], [mod.id, mod]]),
    channels: new Map([
      ["10", { id: "10", type: ChannelType.GuildText, name: "general", parentId: null, overwrites: [] }],
      ["11", {
        id: "11", type: ChannelType.GuildText, name: "staff", parentId: null, overwrites: [
          { id: GUILD, type: OverwriteType.Role, allow: 0n, deny: P.ViewChannel },
          { id: MOD_ROLE, type: OverwriteType.Role, allow: P.ViewChannel, deny: 0n },
        ],
      }],
      ["12", {
        id: "12", type: ChannelType.GuildText, name: "readonly", parentId: null, overwrites: [
          { id: GUILD, type: OverwriteType.Role, allow: 0n, deny: P.ReadMessageHistory },
        ],
      }],
      ["13", { id: "13", type: ChannelType.PublicThread, name: "thread1", parentId: "10", overwrites: [] }],
      ["14", { id: "14", type: ChannelType.PrivateThread, name: "secret-thread", parentId: "10", overwrites: [] }],
    ]),
    members: new Map([
      ["1", { userId: "1", roleIds: [], bot: false }], // owner
      ["2", { userId: "2", roleIds: [MOD_ROLE], bot: false }], // moderator
      ["3", { userId: "3", roleIds: [], bot: false }], // regular member
      [SELF, { userId: SELF, roleIds: [], bot: true }],
    ]),
  };
}
