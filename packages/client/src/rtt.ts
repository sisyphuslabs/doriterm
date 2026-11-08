/** The smoothed round trip of the calls a connection got answers to, in milliseconds. */
export interface RttEstimate {
  readonly srtt: number;
  readonly rttvar: number;
  readonly samples: number;
}

/** RFC 6298's gains: 1/8 for the smoothed mean, 1/4 for its variation. */
const ALPHA = 1 / 8;
const BETA = 1 / 4;

/**
 * TCP's round-trip estimator (design D7): one SRTT over every channel-0 call the core answered, so the wake probe's
 * deadline, the replay quiet window and the predictor's display gate read one measured number instead of three guesses.
 */
export class RttEstimator {
  readonly #now: () => number;
  #srtt = 0;
  #rttvar = 0;
  #samples = 0;
  #estimate: RttEstimate | undefined;

  constructor(now: () => number = () => performance.now()) {
    this.#now = now;
  }

  /** The send instant; hand it back to `sample` when the core's reply arrives. */
  mark(): number {
    return this.#now();
  }

  /** One call the core answered, with a success or an error reply: a timeout, an abort or a dropped link never samples. */
  sample(sentAt: number): void {
    const roundTrip = this.#now() - sentAt;
    if (this.#samples === 0) {
      this.#srtt = roundTrip;
      this.#rttvar = roundTrip / 2;
    } else {
      this.#rttvar = (1 - BETA) * this.#rttvar + BETA * Math.abs(this.#srtt - roundTrip);
      this.#srtt = (1 - ALPHA) * this.#srtt + ALPHA * roundTrip;
    }
    this.#samples += 1;
    this.#estimate = { srtt: this.#srtt, rttvar: this.#rttvar, samples: this.#samples };
  }

  /** The latest sample, or `undefined` until the first one. */
  get estimate(): RttEstimate | undefined {
    return this.#estimate;
  }
}
