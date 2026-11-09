/**
 * When predictions are drawn and when they are underlined: mosh's display triggers, ported with their derivation
 * (src/frontend/terminaloverlay.cc:433-450 and :545-560, constants terminaloverlay.h:215-225). mosh compares its
 * constants with `send_interval`, not with SRTT, and `send_interval = ceil(SRTT / 2)` clamped to [20, 250]
 * (src/network/transportsender-impl.h:61-68, handed to the engine at src/frontend/stmclient.cc:305). This port keeps
 * mosh's constants and computes `sendInterval` the same way, so the effective SRTT thresholds are mosh's: drawn above
 * 60 ms and stopped at 40 ms or less, underlined above 160 ms and no longer at 100 ms or less.
 *
 * The SRTT here is the echo round trip the predictor measures itself (prediction-timing.ts): keypress to the cell
 * showing it, so it includes the host's processing and the output pacer's animation-frame wait (+0-16.7 ms, ~8 on
 * average), which mosh's transport-level SRTT does not. A 10 ms LAN therefore measures about 20-30 ms here, which is
 * still at or under the 40 ms off threshold, so a LAN keeps predictions off as mosh does.
 */

export const SRTT_TRIGGER_LOW = 20;
export const SRTT_TRIGGER_HIGH = 30;
export const FLAG_TRIGGER_LOW = 50;
export const FLAG_TRIGGER_HIGH = 80;
export const GLITCH_THRESHOLD = 250;
export const GLITCH_REPAIR_COUNT = 10;
export const GLITCH_REPAIR_MININTERVAL = 150;
export const GLITCH_FLAG_THRESHOLD = 5000;
export const SEND_INTERVAL_MIN = 20;
export const SEND_INTERVAL_MAX = 250;

/** `adaptive` is mosh's default; `always` and `never` its other two preferences. */
export type DisplayMode = "adaptive" | "always" | "never";

/** mosh's `send_interval` for an SRTT; before any sample, the engine's initial 250 (terminaloverlay.h:310). */
export function sendInterval(srtt: number | undefined): number {
  if (srtt === undefined) return SEND_INTERVAL_MAX;
  return Math.min(SEND_INTERVAL_MAX, Math.max(SEND_INTERVAL_MIN, Math.ceil(srtt / 2)));
}

/** mosh's `srtt_trigger`, `flagging` and `glitch_trigger`, with their hysteresis. */
export class DisplayGate {
  #srttTrigger = false;
  #flagging = false;
  #glitch = 0;
  #lastQuickConfirmation = 0;

  /** Once per cull, with the current `sendInterval` and whether any prediction is outstanding. */
  update(interval: number, active: boolean): void {
    if (interval > SRTT_TRIGGER_HIGH) this.#srttTrigger = true;
    // mosh: "only turn off when no predictions being shown".
    else if (this.#srttTrigger && interval <= SRTT_TRIGGER_LOW && !active) this.#srttTrigger = false;
    if (interval > FLAG_TRIGGER_HIGH) this.#flagging = true;
    else if (interval <= FLAG_TRIGGER_LOW) this.#flagging = false;
    if (this.#glitch > GLITCH_REPAIR_COUNT) this.#flagging = true;
  }

  /** A prediction still waiting `ageMs` after its key: a slow echo shows predictions even on a fast link. */
  pending(ageMs: number): void {
    if (ageMs >= GLITCH_FLAG_THRESHOLD) this.#glitch = GLITCH_REPAIR_COUNT * 2;
    else if (ageMs >= GLITCH_THRESHOLD && this.#glitch < GLITCH_REPAIR_COUNT) this.#glitch = GLITCH_REPAIR_COUNT;
  }

  /** A prediction confirmed `ageMs` after its key: quick confirmations, spaced out, take the glitch trigger away. */
  confirmed(ageMs: number, now: number): void {
    if (
      ageMs < GLITCH_THRESHOLD &&
      this.#glitch > 0 &&
      now - GLITCH_REPAIR_MININTERVAL >= this.#lastQuickConfirmation
    ) {
      this.#glitch -= 1;
      this.#lastQuickConfirmation = now;
    }
  }

  shows(mode: DisplayMode): boolean {
    if (mode === "never") return false;
    return mode === "always" || this.#srttTrigger || this.#glitch > 0;
  }

  /** Drawn predictions are underlined (mosh `flagging`). */
  get underlined(): boolean {
    return this.#flagging;
  }
}
