/**
 * How often `machine.list` is read while a view watches an added machine's line. hc sends nothing when a line drops (a
 * line coming back is announced with `missed`, #2056), and it drops what is written to that machine's terminals meanwhile
 * while keeping their streams open (#1489), so this read is how a view learns to hold its input. Keys typed between the
 * drop and the next read are still lost (an hc gap); a read a second keeps that window short, only while it matters.
 */
export const LINE_READ_MS = 1000;

/** The roster's line read: `machine.list` every LINE_READ_MS while the page is visible and some view watches a line. */
export class LineWatch {
  readonly #refresh: () => void;
  readonly #every: (run: () => void, ms: number) => () => void;
  readonly #visible: () => boolean;
  #watchers = 0;
  #stop: (() => void) | undefined;

  constructor(refresh: () => void, every: (run: () => void, ms: number) => () => void, visible: () => boolean) {
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

  #read(): void {
    if (this.#visible()) this.#refresh();
  }
}
