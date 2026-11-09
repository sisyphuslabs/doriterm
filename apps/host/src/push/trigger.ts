import type { HcEvent, NoticeEvent, Status, Terminal } from "@doriface/protocol";

/** What a status record asks a person for, if anything: input, a permission, or to look at a finished or failed turn. */
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

/** An event's terminal as clients address it: `t7` on this core, `machine/t7` on an added one. */
export function addressOf(event: HcEvent): string | undefined {
  if (event.terminal === undefined) return undefined;
  return event.machine === undefined || event.terminal.includes("/")
    ? event.terminal
    : `${event.machine}/${event.terminal}`;
}

export interface Trigger {
  readonly terminal: string;
  /** The added machine it runs on; undefined on this host's core. */
  readonly machine: string | undefined;
  readonly kind: NoticeEvent;
  /** The status record that raised it: what the agent said, even when its terminal cannot be read afterwards. */
  readonly status: Status;
}

/** One terminal notices one kind at most this often, so an agent flapping between states is one notice. */
export const REPEAT_MS = 30_000;

/**
 * Turns hc's status events into notices: only a change into a state that asks for someone counts. A snapshot (the
 * first, or a `missed` one) sets what each terminal is in and announces nothing, so a restart is quiet.
 */
export class NoticeTrigger {
  readonly #kinds = new Map<string, NoticeEvent | undefined>();
  readonly #last = new Map<string, { readonly kind: NoticeEvent; readonly at: number }>();

  baseline(terminals: readonly Terminal[]): void {
    this.#kinds.clear();
    for (const terminal of terminals) {
      if (terminal.state === "live") this.#kinds.set(terminal.address, noticeKindOf(terminal.status));
    }
  }

  event(event: HcEvent, now: number): Trigger | undefined {
    const terminal = addressOf(event);
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
