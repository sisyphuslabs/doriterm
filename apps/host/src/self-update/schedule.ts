import type { UpdateOutcome } from "./self-update.ts";

export const FIRST_CHECK_MS = 5 * 60 * 1000;
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
export const JITTER_MS = 30 * 60 * 1000;

export interface ScheduleOptions {
  readonly check: () => Promise<UpdateOutcome>;
  /** Called once a new binary is in place; the service host stops and exits so its manager starts it. */
  readonly onUpdated: (version: string) => void;
  readonly log: (line: string) => void;
  readonly timer?: (run: () => void, ms: number) => void;
  readonly random?: () => number;
}

export const describeOutcome = (outcome: UpdateOutcome): string => {
  switch (outcome.kind) {
    case "current":
      return `doriface-host ${outcome.version} is current`;
    case "held":
      return `doriface-host ${outcome.version} is rolling out to ${outcome.rollout}% of hosts, not yet this one`;
    case "below-minimum":
      return `doriface-host ${outcome.version} needs ${outcome.minimum} or later to update itself; reinstall with: curl -fsSL https://get.doriterm.com | sh`;
    case "updated":
      return `doriface-host ${outcome.version} is installed; restarting into it`;
  }
};

/**
 * The service host's own updates (#1969): one check five minutes after start, then every six hours plus up to half an
 * hour of jitter, so a fleet started together does not check together. A failed check is logged and the next one runs.
 */
export function scheduleSelfUpdate(options: ScheduleOptions): void {
  const timer = options.timer ?? ((run, ms) => void setTimeout(run, ms).unref());
  const random = options.random ?? Math.random;
  const later = (): number => CHECK_EVERY_MS + Math.floor(random() * JITTER_MS);
  const once = async (): Promise<void> => {
    try {
      const outcome = await options.check();
      options.log(describeOutcome(outcome));
      if (outcome.kind === "updated") return options.onUpdated(outcome.version);
    } catch (error) {
      options.log(`self-update: ${error instanceof Error ? error.message : String(error)}`);
    }
    timer(() => void once(), later());
  };
  timer(() => void once(), FIRST_CHECK_MS);
}
