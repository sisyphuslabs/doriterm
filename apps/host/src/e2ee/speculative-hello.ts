import type { SecureLink } from "@doriface/crypto";
import type { Link } from "../link.ts";

/** A child the speculative hello runs on: an `hc connect` of its own, never the admitted session's. */
export type SpeculativeChild = Link & { readonly exited: Promise<unknown> };

export interface SpeculativeHelloOptions {
  /** A child for one hello, or undefined when the host may not start one now (its services have not started). */
  readonly spawn: () => SpeculativeChild | undefined;
  /** Children alive at once, draining ones included: a permit is held until the child has exited. */
  readonly maxLive?: number;
  /** Starts in any `windowMs`, charged at start whatever happens next. */
  readonly maxStarts?: number;
  readonly windowMs?: number;
  /** Absolute time from start for the hello's answer; the child is closed then whatever it has sent. */
  readonly answerMs?: number;
  readonly now?: () => number;
}

/** What admission finds: the client already has its hello answer, or the admitted session's own child must give it. */
export type Settled = "answered" | "not-answered";

type Race = { state: "pending" | "answered" | "settled" };

const LF = 0x0a;

/**
 * hc's hello answered alongside Noise message 2, before the client has proved it holds the session's keys (#1271).
 *
 * A replayed message 1 reaches this point, so nothing here may change state or reach the admitted session's child: the
 * hello runs on a separate child (spawned only once the host's own services run, so no core and no publisher is started
 * by it), its only output that leaves is the hello's answer line, sealed to keys a replayer cannot derive, and it is
 * closed once that line is out or at an absolute deadline. A host-wide budget bounds the extra work: at most `maxLive`
 * children alive (a permit is held until the child exits, after its drain) and `maxStarts` starts per window. When the
 * budget is spent, the hello is not answered early: it is held for the admitted session as it always was, so a
 * legitimate client never waits on a slot.
 */
export class SpeculativeHello {
  readonly #spawn: () => SpeculativeChild | undefined;
  readonly #maxLive: number;
  readonly #maxStarts: number;
  readonly #windowMs: number;
  readonly #answerMs: number;
  readonly #now: () => number;
  readonly #children = new Set<SpeculativeChild>();
  readonly #starts: number[] = [];
  readonly #races = new WeakMap<SecureLink, Race>();

  constructor(options: SpeculativeHelloOptions) {
    this.#spawn = options.spawn;
    this.#maxLive = options.maxLive ?? 4;
    this.#maxStarts = options.maxStarts ?? 4;
    this.#windowMs = options.windowMs ?? 10_000;
    this.#answerMs = options.answerMs ?? 2_000;
    this.#now = options.now ?? Date.now;
  }

  /** Children alive now, draining ones included. */
  get live(): number {
    return this.#children.size;
  }

  /** Starts a hello for `session` when the budget allows; otherwise nothing, and the hello waits for admission. */
  answer(early: Uint8Array, session: SecureLink): void {
    if (!this.#admit()) return;
    let child: SpeculativeChild | undefined;
    try {
      child = this.#spawn();
    } catch {
      // An early answer is optional: a child that cannot start (hc moved, no descriptors left) leaves the hello held.
      // The attempt is still a start, so a host that cannot spawn does not retry once per replayed message (#1292).
      this.#starts.push(this.#now());
      return;
    }
    if (child === undefined) return;
    this.#starts.push(this.#now());
    this.#children.add(child);
    void child.exited.finally(() => this.#children.delete(child));
    const race: Race = { state: "pending" };
    this.#races.set(session, race);
    const deadline = setTimeout(() => child.close(), this.#answerMs);
    child.onClose(() => clearTimeout(deadline));
    let held = new Uint8Array(0);
    child.onData((bytes) => {
      if (race.state !== "pending") return child.close();
      const joined = new Uint8Array(held.byteLength + bytes.byteLength);
      joined.set(held);
      joined.set(bytes, held.byteLength);
      const end = joined.indexOf(LF);
      if (end === -1) {
        held = joined;
        return undefined;
      }
      race.state = "answered";
      child.close();
      try {
        session.send(joined.subarray(0, end + 1));
      } catch {
        // The session is gone: its answer had nowhere to go, and the child is closing either way.
      }
      return undefined;
    });
    void child.send(early).catch(() => child.close());
  }

  /**
   * Admission's side of the race, run once as the session is admitted: an answer already sent means the admitted
   * child's own answer to the held hello must not reach the client again; otherwise a late answer never goes out.
   */
  settle(session: SecureLink): Settled {
    const race = this.#races.get(session);
    if (race === undefined) return "not-answered";
    const answered = race.state === "answered";
    race.state = "settled";
    return answered ? "answered" : "not-answered";
  }

  /** Closes every child; resolves once each has exited. */
  async stop(): Promise<void> {
    const children = [...this.#children];
    for (const child of children) child.close();
    await Promise.allSettled(children.map((child) => child.exited));
  }

  #admit(): boolean {
    const now = this.#now();
    while (this.#starts.length > 0 && (this.#starts[0] ?? now) <= now - this.#windowMs) this.#starts.shift();
    return this.#children.size < this.#maxLive && this.#starts.length < this.#maxStarts;
  }
}

/** The admitted session's link with hc's first line (its answer to the held hello) dropped: the client has it already. */
export function withoutFirstLine(link: Link): Link {
  let dropping = true;
  return {
    async send(bytes) {
      if (!dropping) return link.send(bytes);
      const end = bytes.indexOf(LF);
      if (end === -1) return undefined;
      dropping = false;
      const rest = bytes.subarray(end + 1);
      return rest.byteLength === 0 ? undefined : link.send(rest);
    },
    onData: (handler) => link.onData(handler),
    onClose: (handler) => link.onClose(handler),
    close: () => link.close(),
  };
}
