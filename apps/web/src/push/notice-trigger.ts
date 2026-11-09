import {
  eventAddress,
  type HcEvent,
  type NoticeEvent,
  noticeMachineId,
  type PushPrefs,
  type Status,
  type Terminal,
} from "@doriface/protocol";
import { machineOf } from "../workspace/model.ts";

/**
 * The host's push trigger (apps/host/src/push/trigger.ts) as the desktop app runs it on its own event feed, so a
 * desktop notification comes on exactly what a web push comes on.
 */
export function noticeKindOf(status: Status | null | undefined): NoticeEvent | undefined {
  switch (status?.state) {
    case "blocked":
      return status.kind === "permission" ? "permission" : "input";
    case "done":
      return "done";
    case "error":
      return "error";
    default:
      return undefined;
  }
}

export interface Trigger {
  readonly terminal: string;
  /** The added machine it runs on; undefined on this host's core. */
  readonly machine: string | undefined;
  readonly kind: NoticeEvent;
  /** The status record that raised it: what the agent said, even when its terminal cannot be read afterwards. */
  readonly status: Status;
}

/** A terminal in a state that asks for someone, as the feed last told it; what it said is not kept. */
export type Waiting = Pick<Trigger, "terminal" | "machine" | "kind">;

/** One terminal notices one kind at most this often, so an agent flapping between states is one notice. */
export const REPEAT_MS = 30_000;

/** Only a change into a state that asks for someone counts; a snapshot sets each terminal's state and announces nothing. */
export class NoticeTrigger {
  readonly #kinds = new Map<string, NoticeEvent | undefined>();
  readonly #last = new Map<string, { readonly kind: NoticeEvent; readonly at: number }>();

  baseline(terminals: readonly Terminal[]): void {
    this.#kinds.clear();
    for (const terminal of terminals) {
      if (terminal.state === "live") this.#kinds.set(terminal.address, noticeKindOf(terminal.status));
    }
  }

  /** Every terminal in a state that asks for someone, as the feed last told: live, so announced ones count too. */
  waiting(): readonly Waiting[] {
    const hits: Waiting[] = [];
    for (const [terminal, kind] of this.#kinds) {
      if (kind !== undefined) hits.push({ terminal, machine: machineOf(terminal), kind });
    }
    return hits;
  }

  event(event: HcEvent, now: number): Trigger | undefined {
    const terminal = eventAddress(event);
    if (terminal === undefined) return undefined;
    if (event.type === "removed" || event.type === "finished") {
      this.#kinds.delete(terminal);
      this.#last.delete(terminal);
      return undefined;
    }
    if (event.type !== "status") return undefined;
    const status = event.data.status;
    const kind = noticeKindOf(status);
    const before = this.#kinds.get(terminal);
    this.#kinds.set(terminal, kind);
    if (kind === undefined || status == null || kind === before) return undefined;
    const last = this.#last.get(terminal);
    if (last !== undefined && last.kind === kind && now - last.at < REPEAT_MS) return undefined;
    this.#last.set(terminal, { kind, at: now });
    return { terminal, machine: event.machine, kind, status };
  }
}

/** Whether a hit is one this device asked to hear: its kind on, its machine not muted, its pane not the one in view. */
export const wanted = (hit: Waiting, prefs: PushPrefs, shown: string | null): boolean =>
  prefs.events[hit.kind] && !prefs.muted.includes(noticeMachineId(hit.machine)) && hit.terminal !== shown;
