import { type HcConnection, HcTimeoutError } from "@doriface/client";
import { type UnprovenLinks, unprovenLinks, WakeProbeUnansweredError } from "./wake.ts";

/** The longest a wake's check waits, and the whole wait when the link has no round-trip sample yet (#653). */
export const WAKE_PROBE_MAX_MS = 10_000;
/** The shortest: a slow but live relay link is not dropped into a reconnect for answering in two round trips. */
export const WAKE_PROBE_MIN_MS = 1_500;

/**
 * How long a wake gives an open link to answer one call before it is treated as gone (#1370): four smoothed round trips
 * and 500 ms, as a retransmission timeout is sized, kept within {@link WAKE_PROBE_MIN_MS}..{@link WAKE_PROBE_MAX_MS}.
 */
export function wakeProbeMs(srtt: number | undefined): number {
  if (srtt === undefined || !Number.isFinite(srtt)) return WAKE_PROBE_MAX_MS;
  return Math.min(WAKE_PROBE_MAX_MS, Math.max(WAKE_PROBE_MIN_MS, 4 * srtt + 500));
}

/** A connection's smoothed round trip in ms, or undefined before its first sample. */
export type SrttOf = (connection: HcConnection) => number | undefined;

/**
 * The seam the connection's own round-trip estimator plugs into (S0 of the remote-input plan). Until it does, no link has
 * a sample, so every wake waits {@link WAKE_PROBE_MAX_MS} as before.
 */
export const noSrtt: SrttOf = () => undefined;

/** How a store sizes a wake's check and where it lists the link meanwhile; both are the app's own unless a test passes others. */
export interface WakeProbing {
  readonly srttOf?: SrttOf | undefined;
  readonly links?: UnprovenLinks | undefined;
}

/**
 * A wake's check on an open link (#653): one call the core answers at once. An answer of any kind, an error included,
 * proves the link; no answer within {@link wakeProbeMs} of its round trip goes to `unanswered`, which drops the link.
 * Until the check settles the link is listed as unproven, so typed input waits instead of going into it (#1370).
 */
export class WakeProbe {
  /** The link a check is out on, so several page events cost one call. */
  #probing: HcConnection | null = null;
  readonly #srttOf: SrttOf;
  readonly #links: UnprovenLinks;

  constructor(probing: WakeProbing = {}) {
    this.#srttOf = probing.srttOf ?? noSrtt;
    this.#links = probing.links ?? unprovenLinks;
  }

  ask(
    connection: HcConnection,
    proving: (on: boolean) => void,
    unanswered: (reason: WakeProbeUnansweredError) => void,
  ): void {
    if (this.#probing === connection) return;
    this.#probing = connection;
    this.#links.start(connection);
    proving(true);
    void connection
      .call("terminal.list", {}, { timeoutMs: wakeProbeMs(this.#srttOf(connection)) })
      .then(
        () => true,
        (error: unknown) => {
          // A stop, or a newer connection, ended this check's claim on the link while it waited.
          if (error instanceof HcTimeoutError && this.#probing === connection)
            unanswered(new WakeProbeUnansweredError(error.method, error.timeoutMs));
          return !(error instanceof HcTimeoutError) && !connection.closed;
        },
      )
      .then((proven) => {
        if (this.#probing === connection) this.#probing = null;
        proving(false);
        this.#links.settle(connection, proven);
        return proven;
      });
  }

  /** Ends the check's claim on its link: the store is closing it, so what waited goes to the next stream. */
  stop(): void {
    const probing = this.#probing;
    this.#probing = null;
    if (probing !== null) this.#links.settle(probing, false);
  }
}
