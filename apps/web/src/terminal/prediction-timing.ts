/**
 * The predictor's own round trip, measured on echoes: keypress to the cell showing it. It is seeded by the first
 * confirmation, never by the attach call: on a first attach that call was started with the run (opening-attach.ts,
 * `takeOpeningAttach`), so its duration is anything from ~0 ms to more than a round trip. Nothing is drawn before the
 * first confirmation anyway (the epoch is unconfirmed), so the seed costs nothing visible. RFC 6298's estimator:
 * the first sample R gives SRTT = R and RTTVAR = R / 2, later ones the 1/8 and 1/4 gains.
 */
export interface EchoRoundTrip {
  readonly srtt: number;
  readonly rttvar: number;
}

const ALPHA = 1 / 8;
const BETA = 1 / 4;

export class EchoRtt {
  #estimate: EchoRoundTrip | undefined;

  sample(roundTripMs: number): void {
    const previous = this.#estimate;
    this.#estimate =
      previous === undefined
        ? { srtt: roundTripMs, rttvar: roundTripMs / 2 }
        : {
            rttvar: (1 - BETA) * previous.rttvar + BETA * Math.abs(previous.srtt - roundTripMs),
            srtt: (1 - ALPHA) * previous.srtt + ALPHA * roundTripMs,
          };
  }

  get estimate(): EchoRoundTrip | undefined {
    return this.#estimate;
  }
}

/**
 * How long an unechoed prediction is kept before it expires: RFC 6298's retransmission timeout, SRTT + 4 * RTTVAR,
 * with the RFC's own one-second floor (section 2.4). Expiry is the only judgement time may make, and it must not fire on
 * an echo that is merely late: the floor keeps relay jitter (270-400 ms) far from it, and the RTO term follows a link
 * whose echoes take longer than a second. It is also the bound on how long a key the program never echoes stays drawn.
 */
export const EXPIRE_FLOOR_MS = 1000;

export function expiryMs(rtt: EchoRoundTrip | undefined): number {
  if (rtt === undefined) return EXPIRE_FLOOR_MS;
  return Math.max(EXPIRE_FLOOR_MS, rtt.srtt + 4 * rtt.rttvar);
}
