import { PresenceUpdateStatus } from "discord-api-types/v10";
import type { GatewayPresenceUpdateData } from "discord-api-types/v10";

// The bot shows online while a conversation is awake in any channel and idle
// while all of them sleep. Offline needs nothing: Discord shows it once the
// gateway connection is gone.

export interface PresenceDeps {
  /** The latest time any conversation stays awake, if one is awake now. */
  awakeUntil: (now: number) => number | undefined;
  send: (presence: GatewayPresenceUpdateData) => Promise<void>;
  now: () => number;
  log: (message: string, error?: unknown) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

type Status = PresenceUpdateStatus.Online | PresenceUpdateStatus.Idle;

export class Presence {
  readonly deps: PresenceDeps;
  #sent: Status | null = null;
  #timer: unknown = null;

  constructor(deps: PresenceDeps) {
    this.deps = deps;
  }

  /** Recomputes the status; call on connect and whenever a conversation wakes or is extended. */
  refresh(): void {
    const { deps } = this;
    const now = deps.now();
    const until = deps.awakeUntil(now);
    if (this.#timer !== null) (deps.clearTimer ?? clearTimeout)(this.#timer as ReturnType<typeof setTimeout>);
    this.#timer = null;
    // Look again when the last awake conversation falls asleep.
    if (until !== undefined) this.#timer = (deps.setTimer ?? setTimeout)(() => this.refresh(), until - now + 1000);
    this.#set(until !== undefined ? PresenceUpdateStatus.Online : PresenceUpdateStatus.Idle);
  }

  /** The connection was (re)made, so the next status is sent even if unchanged. */
  reset(): void {
    this.#sent = null;
  }

  stop(): void {
    if (this.#timer !== null) (this.deps.clearTimer ?? clearTimeout)(this.#timer as ReturnType<typeof setTimeout>);
    this.#timer = null;
  }

  #set(status: Status): void {
    if (this.#sent === status) return;
    this.#sent = status;
    this.deps
      .send({ status, activities: [], since: status === PresenceUpdateStatus.Idle ? this.deps.now() : null, afk: status === PresenceUpdateStatus.Idle })
      .catch((e) => {
        this.#sent = null;
        this.deps.log("ステータスの更新に失敗", e);
      });
  }
}
