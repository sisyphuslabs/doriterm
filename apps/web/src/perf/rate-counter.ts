/** One recorded sample inside the counter's sliding window. */
interface Sample {
  readonly value: number;
  readonly at: number;
}

/** Observed sample rate and distinct-value rate over the trailing second. */
export interface RateSnapshot {
  readonly perSecond: number;
  readonly uniquePerSecond: number;
}

/** Width of the sliding measurement window in milliseconds. */
const WINDOW_MS = 1000;

/**
 * Counts how many samples arrived and how many distinct values they carried over a sliding one-second window.
 * Keeping both counts separates poll frequency from how often the underlying position actually changed.
 */
export class RateCounter {
  private samples: Sample[] = [];
  private head = 0;

  add(value: number, at: number): void {
    const last = this.samples[this.samples.length - 1];
    if (last !== undefined && at < last.at) {
      // Preserve timestamp order if a caller supplies an out-of-order clock reading so head pruning stays valid.
      let index = this.samples.length;
      while (index > this.head) {
        const prev = this.samples[index - 1];
        if (prev === undefined || prev.at <= at) break;
        index -= 1;
      }
      this.samples.splice(index, 0, { value, at });
    } else {
      this.samples.push({ value, at });
    }
    this.prune(at);
  }

  rates(now: number): RateSnapshot {
    this.prune(now);
    const unique = new Set<number>();
    let count = 0;
    for (let i = this.head; i < this.samples.length; i += 1) {
      const sample = this.samples[i];
      if (sample === undefined) continue;
      count += 1;
      unique.add(sample.value);
    }
    return { perSecond: count, uniquePerSecond: unique.size };
  }

  private prune(now: number): void {
    const cutoff = now - WINDOW_MS;
    while (this.head < this.samples.length) {
      const sample = this.samples[this.head];
      if (sample === undefined || sample.at >= cutoff) break;
      this.head += 1;
    }
    if (this.head >= 64 && this.head * 2 >= this.samples.length) {
      this.samples = this.samples.slice(this.head);
      this.head = 0;
    }
  }
}
