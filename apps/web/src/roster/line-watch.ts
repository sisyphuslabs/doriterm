/**
 * How often `machine.list` is read while a view watches an added machine's line. hc sends nothing when a line drops (a
 * line coming back is announced with `missed`, #2056), and it drops what is written to that machine's terminals meanwhile
 * while keeping their streams open (#1489), so this read is how a view learns to hold its input. Keys typed between the
 * drop and the next read are still lost (an hc gap); a read a second keeps that window short, only while it matters.
 */
export const LINE_READ_MS = 1000;

/**
 * The roster's line read: `machine.list` every LINE_READ_MS while the page is visible and some view watches a line, one
 * read at a time, so a stalled link is not sent a read a second it cannot answer (#2184).
 */
export class LineWatch {
  readonly #refresh: () => Promise<void>;
  readonly #every: (run: () => void, ms: number) => () => void;
  readonly #visible: () => boolean;
  #watchers = 0;
  #stop: (() => void) | undefined;
  #inFlight: Promise<void> | undefined;

  constructor(
    refresh: () => Promise<void>,
    every: (run: () => void, ms: number) => () => void,
    visible: () => boolean,
  ) {
    this.#refresh = refresh;
    this.#every = every;
    this.#visible = visible;
  }

  /** Starts the reads, the first at once, for one view; its stop ends them once every view's stop has run. */
  watch(): () => void {
    this.#watchers += 1;
    if (this.#watchers === 1) {
      this.#stop = this.#every(() => this.#read(), LINE_READ_MS);
      this.#read();
    }
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      this.#watchers -= 1;
      if (this.#watchers > 0) return;
      this.#stop?.();
      this.#stop = undefined;
    };
  }

  /** Settles once the line read in flight, if any, has: what a test waits on instead of time. */
  idle(): Promise<void> {
    return this.#inFlight ?? Promise.resolve();
  }

  #read(): void {
    if (this.#inFlight !== undefined || !this.#visible()) return;
    this.#inFlight = this.#refresh().finally(() => {
      this.#inFlight = undefined;
    });
  }
}
